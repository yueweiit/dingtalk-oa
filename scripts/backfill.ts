import { getConfig } from '../src/config/index.js';
import { closePool } from '../src/db/pool.js';
import { runBackfill } from '../src/jobs/backfill.js';

function parseArg(args: string[], name: string): string | undefined {
  const arg = args.find(a => a.startsWith(`${name}=`));
  return arg ? arg.split('=')[1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
用法: npx tsx scripts/backfill.ts [选项]

选项:
  --days=N            回溯天数（默认 365，与 --start/--end 互斥）
  --start=YYYY-MM-DD  开始日期（与 --days 互斥）
  --end=YYYY-MM-DD    结束日期（默认今天，需配合 --start 使用）
  --chunk-days=N      每个子窗口天数（默认 7，越小越安全）
  --delay-ms=N        每条实例间隔毫秒（默认 500，越小越快）
  --process-code=XXX  只补指定模板（默认全部）
  --corp-id=XXX       只补指定企业（默认全部）
  -h, --help          显示帮助

钉钉 API 限制说明:
  - 搜索接口: 40 QPS，建议 chunk-days=7 配合 delay-ms=500
  - 单次搜索最多返回 20 条，超过需翻页
  - 时间窗口越大、数据越多，被限流风险越高

示例:
  npx tsx scripts/backfill.ts --days=365                    # 补一年，7天一切窗口
  npx tsx scripts/backfill.ts --days=30 --chunk-days=3     # 补30天，3天一切
  npx tsx scripts/backfill.ts --days=7 --delay-ms=200      # 补7天，加速模式
  npx tsx scripts/backfill.ts --process-code=PROC-XXX      # 只补指定模板
  npx tsx scripts/backfill.ts --start=2026-01-01 --end=2026-06-30  # 指定时间范围
  npx tsx scripts/backfill.ts --start=2026-01-01 --process-code=PROC-XXX  # 指定模板+时间范围
`);
    process.exit(0);
  }

  const daysArg = parseArg(args, 'days');
  const startArg = parseArg(args, 'start');
  const endArg = parseArg(args, 'end');
  const chunkDays = parseInt(parseArg(args, 'chunk-days') || '7', 10);
  const delayMs = parseInt(parseArg(args, 'delay-ms') || '500', 10);
  const processCode = parseArg(args, 'process-code');
  const corpId = parseArg(args, 'corp-id');

  if (daysArg && startArg) {
    console.error('错误: --days 和 --start 不能同时使用');
    process.exit(1);
  }

  const config = getConfig();
  const targetCorpId = corpId || config.DINGTALK_CORP_ID;

  let window_start: Date;
  let window_end: Date;

  if (startArg) {
    window_start = new Date(startArg);
    if (isNaN(window_start.getTime())) {
      console.error('错误: --start 日期格式无效，请使用 YYYY-MM-DD');
      process.exit(1);
    }
    window_end = endArg ? new Date(endArg) : new Date();
    if (isNaN(window_end.getTime())) {
      console.error('错误: --end 日期格式无效，请使用 YYYY-MM-DD');
      process.exit(1);
    }
  } else {
    const days = parseInt(daysArg || '365', 10);
    window_end = new Date();
    window_start = new Date(window_end.getTime() - days * 24 * 60 * 60 * 1000);
  }
  const totalDays = Math.ceil((window_end.getTime() - window_start.getTime()) / (24 * 60 * 60 * 1000));
  const totalChunks = Math.ceil(totalDays / chunkDays);

  console.log('========== 补数据任务 ==========');
  console.log(`企业 ID: ${targetCorpId || '(全部)'}`);
  console.log(`模板: ${processCode || '(全部)'}`);
  console.log(`时间范围: ${window_start.toISOString().slice(0, 10)} ~ ${window_end.toISOString().slice(0, 10)}`);
  console.log(`回溯天数: ${totalDays}`);
  console.log(`子窗口: ${chunkDays} 天/个，共 ${totalChunks} 个`);
  console.log(`实例延迟: ${delayMs}ms`);
  console.log('================================\n');

  try {
    await runBackfill({
      corp_id: targetCorpId,
      process_code: processCode,
      window_start,
      window_end,
      delayMs,
      chunkDays,
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
