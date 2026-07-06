import { getConfig } from '../src/config/index.js';
import { getPool, closePool } from '../src/db/pool.js';
import { listProcessTemplates, getUser, listDepartments, listUsers } from '../src/dingtalk/api-client.js';
import { computeUserHash } from '../src/normalize/user-snapshot.js';
import { findAnyOriginatorUserId } from '../src/db/queries/approval-instance.js';

getConfig();
const pool = getPool();

// ========== 模板名称同步 ==========
async function syncTemplateNames(corpId: string) {
  console.log('\n===== 同步模板名称 =====');
  const userId = await findAnyOriginatorUserId();
  if (!userId) {
    console.log('没有可用的 userId，跳过模板同步');
    return;
  }
  const remote = await listProcessTemplates(userId);
  console.log(`钉钉 API 返回 ${remote.length} 个模板`);

  const { rows: local } = await pool.query(
    'SELECT id, process_code, name FROM ding_process_template WHERE corp_id = $1',
    [corpId]
  );
  const localMap = new Map(local.map((t: any) => [t.process_code, t]));

  let updated = 0;

  for (const r of remote) {
    const localRow = localMap.get(r.processCode);
    if (!localRow) {
      // 新模板，插入
      await pool.query(
        `INSERT INTO ding_process_template (corp_id, process_code, name, enabled)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (corp_id, process_code) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
        [corpId, r.processCode, r.name || null]
      );
      console.log(`  ➕ 新增: ${r.processCode} - ${r.name || '(无名)'}`);
      updated++;
    } else if (r.name && r.name !== localRow.name) {
      // 更新名称
      await pool.query(
        'UPDATE ding_process_template SET name = $1, updated_at = now() WHERE id = $2',
        [r.name, localRow.id]
      );
      console.log(`  ✅ 更新: ${r.processCode}: "${localRow.name || '(空)'}" → "${r.name}"`);
      updated++;
    } else {
      console.log(`  ⏭️  ${r.processCode}: "${localRow.name || r.name || '(无名)'}" 无需更新`);
    }
  }

  console.log(`模板同步完成，更新 ${updated} 条`);
}

// ========== 用户信息同步 ==========
async function syncUsers(corpId: string) {
  console.log('\n===== 同步用户信息 =====');

  // 1. 递归获取所有部门
  console.log('  获取部门列表...');
  const allDepts: { dept_id: number; name: string }[] = [];
  const queue = [1]; // 从根部门开始
  while (queue.length > 0) {
    const deptId = queue.shift()!;
    try {
      const subDepts = await listDepartments(deptId);
      for (const dept of subDepts) {
        allDepts.push(dept);
        queue.push(dept.dept_id);
      }
    } catch (e: any) {
      console.log(`  ⚠️  获取部门 ${deptId} 子部门失败: ${e.message}`);
    }
  }
  console.log(`  共找到 ${allDepts.length} 个部门`);

  // 2. 获取所有部门下的用户
  const allUsers = new Map<string, any>();
  for (const dept of allDepts) {
    let cursor = 0;
    let hasMore = true;
    while (hasMore) {
      try {
        const result = await listUsers(dept.dept_id, cursor);
        for (const user of result.list) {
          if (user.userid && !allUsers.has(user.userid)) {
            allUsers.set(user.userid, user);
          }
        }
        hasMore = result.hasMore;
        cursor = result.nextCursor;
      } catch (e: any) {
        console.log(`  ⚠️  获取部门 ${dept.name}(${dept.dept_id}) 用户失败: ${e.message}`);
        hasMore = false;
      }
    }
  }
  console.log(`  共找到 ${allUsers.size} 个用户`);

  if (allUsers.size === 0) {
    console.log('没有需要同步的用户');
    return;
  }

  // 3. 同步用户快照
  let success = 0, skipped = 0, failed = 0;
  for (const [userId, userSummary] of allUsers) {
    try {
      // 用 getUser 获取完整用户信息
      const user = await getUser(userId);
      const snapshotHash = computeUserHash(user);

      const { rows: existing } = await pool.query(
        `SELECT id, snapshot_hash FROM ding_user_snapshot
         WHERE corp_id = $1 AND user_id = $2 AND is_current = true LIMIT 1`,
        [corpId, userId]
      );

      if (existing.length > 0 && existing[0].snapshot_hash === snapshotHash) {
        skipped++;
        continue;
      }

      if (existing.length > 0) {
        await pool.query(
          'UPDATE ding_user_snapshot SET valid_to = now(), is_current = false, updated_at = now() WHERE id = $1',
          [existing[0].id]
        );
      }

      await pool.query(
        `INSERT INTO ding_user_snapshot
           (corp_id, user_id, name, dept_id_list, title, avatar, snapshot_hash, fetch_status, raw_payload, is_current)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'success', $8, true)`,
        [
          corpId, userId,
          user.name || null,
          user.dept_id_list ? JSON.stringify(user.dept_id_list) : null,
          user.title || null, user.avatar || null,
          snapshotHash, JSON.stringify(user),
        ]
      );

      // 回填实例表和任务表的姓名
      await pool.query(
        `UPDATE ding_approval_instance SET originator_user_name = COALESCE(originator_user_name, $1), updated_at = now()
         WHERE corp_id = $2 AND originator_user_id = $3 AND (originator_user_name IS NULL OR originator_user_name = '')`,
        [user.name, corpId, userId]
      );
      await pool.query(
        `UPDATE ding_approval_task SET approver_user_name = COALESCE(approver_user_name, $1), updated_at = now()
         WHERE corp_id = $2 AND approver_user_id = $3 AND (approver_user_name IS NULL OR approver_user_name = '')`,
        [user.name, corpId, userId]
      );

      success++;
    } catch (e: any) {
      failed++;
    }
  }

  console.log(`用户同步完成: 成功 ${success}, 跳过 ${skipped}, 失败 ${failed}`);
}

// ========== 主流程 ==========
async function main() {
  const args = process.argv.slice(2);
  const onlyTemplates = args.includes('--templates');
  const onlyUsers = args.includes('--users');
  const runAll = !onlyTemplates && !onlyUsers;

  const config = getConfig();
  const corpId = config.DINGTALK_CORP_ID;

  if (!corpId) {
    console.error('错误: DINGTALK_CORP_ID 未配置');
    process.exit(1);
  }

  console.log(`企业 ID: ${corpId}`);

  if (runAll || onlyTemplates) {
    try { await syncTemplateNames(corpId); } catch (e: any) { console.error('模板同步失败:', e.message); }
  }
  if (runAll || onlyUsers) {
    try { await syncUsers(corpId); } catch (e: any) { console.error('用户同步失败:', e.message); }
  }

  await closePool();
  console.log('\n全部完成');
}

main().catch(e => { console.error(e); process.exit(1); });
