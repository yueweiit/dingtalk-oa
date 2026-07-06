import { getConfig } from '../src/config/index.js';
import { closePool } from '../src/db/pool.js';
import { runBackfill } from '../src/jobs/backfill.js';

async function main() {
  const args = process.argv.slice(2);

  // 解析参数
  const daysArg = args.find(a => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 365;

  const codeArg = args.find(a => a.startsWith('--process-code='));
  const processCode = codeArg ? codeArg.split('=')[1] : undefined;

  const corpArg = args.find(a => a.startsWith('--corp-id='));
  const corpId = corpArg ? corpArg.split('=')[1] : undefined;

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
用法: npx tsx scripts/backfill.ts [选项]

选项:
  --days=N            回溯天数（默认 365）
  --process-code=XXX  只补指定模板（默认全部）
  --corp-id=XXX       只补指定企业（默认全部）
  -h, --help          显示帮助

示例:
  npx tsx scripts/backfill.ts                    # 补最近 365 天全部模板
  npx tsx scripts/backfill.ts --days=30          # 补最近 30 天
  npx tsx scripts/backfill.ts --process-code=PROC-XXX  # 只补指定模板
`);
    process.exit(0);
  }

  const config = getConfig();
  const targetCorpId = corpId || config.DINGTALK_CORP_ID;

  const window_end = new Date();
  const window_start = new Date(window_end.getTime() - days * 24 * 60 * 60 * 1000);

  console.log('========== 补数据任务 ==========');
  console.log(`企业 ID: ${targetCorpId || '(全部)'}`);
  console.log(`模板: ${processCode || '(全部)'}`);
  console.log(`时间范围: ${window_start.toISOString()} ~ ${window_end.toISOString()}`);
  console.log(`回溯天数: ${days}`);
  console.log('================================\n');

  try {
    await runBackfill({
      corp_id: targetCorpId,
      process_code: processCode,
      window_start,
      window_end,
    });
    console.log('\n✅ 补数据完成');
  } catch (error: any) {
    console.error('\n❌ 补数据失败:', error.message);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
