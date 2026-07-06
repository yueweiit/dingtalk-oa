import cron from 'node-cron';
import { getConfig } from '../config/index.js';
import { runBackfill } from './backfill.js';
import { syncProcessTemplates } from './process-template-sync.js';
import { cleanupOldEvents } from '../db/queries/event-log.js';

let scheduledTasks: cron.ScheduledTask[] = [];

export function startScheduler(): void {
  const config = getConfig();

  console.log('[Scheduler] 启动定时任务调度器');

  // 每天凌晨 2 点：扫描最近 N 天（兜底 Stream 漏数据）
  const backfillTask = cron.schedule('0 2 * * *', async () => {
    console.log('[Scheduler] 执行每日补数据任务');

    try {
      const lookbackDays = config.BACKFILL_LOOKBACK_DAYS;

      const window_end = new Date();
      const window_start = new Date(window_end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

      await runBackfill({
        window_start,
        window_end,
      });

      console.log('[Scheduler] 每日补数据任务完成');
    } catch (error) {
      console.error('[Scheduler] 每日补数据任务失败:', error);
    }
  }, {
    timezone: 'Asia/Shanghai',
  });

  // 每天凌晨 3 点：清理 90 天前的 ding_event_log（保留失败事件）
  const cleanupTask = cron.schedule('0 3 * * *', async () => {
    console.log('[Scheduler] 执行事件日志清理任务');

    try {
      const deletedCount = await cleanupOldEvents(90);
      console.log(`[Scheduler] 清理完成，删除 ${deletedCount} 条记录`);
    } catch (error) {
      console.error('[Scheduler] 事件日志清理失败:', error);
    }
  }, {
    timezone: 'Asia/Shanghai',
  });

  // 每天凌晨 4 点：同步审批模板
  const templateSyncTask = cron.schedule('0 4 * * *', async () => {
    console.log('[Scheduler] 执行审批模板同步任务');

    try {
      await syncProcessTemplates();
      console.log('[Scheduler] 审批模板同步任务完成');
    } catch (error) {
      console.error('[Scheduler] 审批模板同步任务失败:', error);
    }
  }, {
    timezone: 'Asia/Shanghai',
  });

  scheduledTasks.push(backfillTask, cleanupTask, templateSyncTask);

  console.log('[Scheduler] 定时任务已注册:');
  console.log('  - 每天 02:00: 补数据任务');
  console.log('  - 每天 03:00: 事件日志清理');
  console.log('  - 每天 04:00: 审批模板同步');
}

export function stopScheduler(): void {
  for (const task of scheduledTasks) {
    task.stop();
  }
  scheduledTasks = [];
  console.log('[Scheduler] 定时任务已停止');
}

/**
 * 手动触发补数据任务
 */
export async function triggerBackfill(params: {
  corp_id?: string;
  process_code?: string;
  window_start?: Date;
  window_end?: Date;
}): Promise<void> {
  console.log('[Scheduler] 手动触发补数据任务:', params);
  await runBackfill(params);
}
