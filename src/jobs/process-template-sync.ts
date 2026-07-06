import { listProcessTemplates } from '../dingtalk/api-client.js';
import { getAllCorpIds } from '../db/queries/corp-config.js';
import { findAnyOriginatorUserId } from '../db/queries/approval-instance.js';
import {
  findAllTemplates,
  upsertProcessTemplate,
  markAsDeleted,
  updateTemplateName,
} from '../db/queries/process-template.js';

/**
 * 定时同步审批模板
 * 定时同步只负责补全模板名称、更新模板状态、标记已删除模板
 * 不作为唯一模板发现来源（发现由事件兜底完成）
 */
export async function syncProcessTemplates(corp_id?: string): Promise<void> {
  // 如果未指定 corp_id，从数据库获取所有活跃的企业
  let corpIds: string[];
  if (corp_id) {
    corpIds = [corp_id];
  } else {
    const corps = await getAllCorpIds();
    corpIds = corps.map(c => c.corp_id);
  }

  if (corpIds.length === 0) {
    console.warn('[ProcessTemplateSync] 没有找到活跃的企业 ID');
    return;
  }

  for (const cid of corpIds) {
    await syncCorpTemplates(cid);
  }
}

async function syncCorpTemplates(corp_id: string): Promise<void> {
  console.log(`[ProcessTemplateSync] 开始同步审批模板: ${corp_id}`);

  try {
    // 1. 获取钉钉当前所有模板
    const userId = await findAnyOriginatorUserId();
    if (!userId) {
      console.warn(`[ProcessTemplateSync] 没有可用的 userId，跳过同步: ${corp_id}`);
      return;
    }
    const remoteTemplates = await listProcessTemplates(userId);
    console.log(`[ProcessTemplateSync] 钉钉返回 ${remoteTemplates.length} 个模板`);

    // 2. 获取数据库中所有模板
    const localTemplates = await findAllTemplates(corp_id);
    const localTemplateMap = new Map(localTemplates.map((t) => [t.process_code, t]));

    // 3. 处理远程模板
    for (const remote of remoteTemplates) {
      const local = localTemplateMap.get(remote.processCode);

      if (!local) {
        // 新模板，插入
        console.log(`[ProcessTemplateSync] 发现新模板: ${remote.processCode} - ${remote.name || '(无名)'}`);
        await upsertProcessTemplate({
          corp_id,
          process_code: remote.processCode,
          name: remote.name || null,
          enabled: true,
        });
      } else {
        // 已存在，更新名称
        const remoteName = remote.name || null;
        if (!local.name && remoteName) {
          console.log(`[ProcessTemplateSync] 补全模板名称: ${remote.processCode} - ${remoteName}`);
          await updateTemplateName(corp_id, remote.processCode, remoteName);
        } else if (remoteName && local.name !== remoteName) {
          console.log(`[ProcessTemplateSync] 更新模板名称: ${remote.processCode} - ${remoteName}`);
          await updateTemplateName(corp_id, remote.processCode, remoteName);
        }

        // 标记为未删除（如果之前被标记为删除）
        if (local.is_deleted) {
          console.log(`[ProcessTemplateSync] 模板重新上线: ${remote.processCode}`);
          await upsertProcessTemplate({
            corp_id,
            process_code: remote.processCode,
            name: remote.name,
            enabled: true,
          });
        }
      }
    }

    // 4. 标记已删除的模板
    const remoteProcessCodes = new Set(remoteTemplates.map((t) => t.processCode));
    for (const local of localTemplates) {
      if (!remoteProcessCodes.has(local.process_code) && !local.is_deleted) {
        console.log(`[ProcessTemplateSync] 标记模板已删除: ${local.process_code}`);
        await markAsDeleted(corp_id, local.process_code);
      }
    }

    console.log(`[ProcessTemplateSync] 审批模板同步完成: ${corp_id}`);
  } catch (error) {
    console.error(`[ProcessTemplateSync] 同步审批模板失败: ${corp_id}`, error);
    throw error;
  }
}
