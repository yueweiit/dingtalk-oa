import { getConfig } from '../config/index.js';
import { getPool, closePool } from '../db/pool.js';
import { ensureCorpConfigTable, getActiveCorpId } from '../db/queries/corp-config.js';
import { runBackfill } from '../jobs/backfill.js';
import { tokenManager } from '../dingtalk/token-manager.js';

async function main() {
  const args = process.argv.slice(2);

  // 解析参数
  const processCode = args.find((arg, i) => i === 0 && !arg.startsWith('--')) || args.find((_, i) => args[i - 1] === '--code');
  const startDate = args.find((_, i) => args[i - 1] === '--start');
  const endDate = args.find((_, i) => args[i - 1] === '--end');

  if (!processCode || args.includes('--help') || args.includes('-h')) {
    console.log(`
钉钉审批数据手动获取工具

用法:
  npm run fetch -- <processCode> [options]

参数:
  <processCode>           审批模板码（必填）

选项:
  --start <YYYY-MM-DD>    开始时间（默认: 30 天前）
  --end <YYYY-MM-DD>      结束时间（默认: 今天）
  --help, -h              显示帮助信息

示例:
  npm run fetch -- PROC-XXXXX
  npm run fetch -- PROC-XXXXX --start 2026-01-01 --end 2026-06-30
`);
    process.exit(0);
  }

  console.log('🚀 钉钉审批数据手动获取');
  console.log(`📋 模板码: ${processCode}`);

  // 初始化
  const config = getConfig();
  const pool = getPool();
  await ensureCorpConfigTable();

  // 检查 corp_id
  const corpId = await getActiveCorpId();
  if (!corpId) {
    console.error('❌ 没有找到活跃的企业 ID，请先启动服务接收至少一个事件');
    process.exit(1);
  }
  console.log(`🏢 企业 ID: ${corpId}`);

  // 解析时间范围
  const window_end = endDate ? new Date(endDate + 'T23:59:59Z') : new Date();
  const window_start = startDate
    ? new Date(startDate + 'T00:00:00Z')
    : new Date(window_end.getTime() - config.BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  console.log(`📅 时间范围: ${window_start.toISOString().split('T')[0]} ~ ${window_end.toISOString().split('T')[0]}`);

  // 验证 token
  try {
    await tokenManager.getToken();
    console.log('✅ Token 验证成功');
  } catch (error) {
    console.error('❌ Token 验证失败:', error);
    process.exit(1);
  }

  // 执行补数据
  try {
    console.log('\n⏳ 开始获取数据...\n');

    await runBackfill({
      corp_id: corpId,
      process_code: processCode,
      window_start,
      window_end,
    });

    console.log('\n✅ 数据获取完成');
  } catch (error) {
    console.error('\n❌ 数据获取失败:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error('❌ 程序异常:', error);
  process.exit(1);
});
