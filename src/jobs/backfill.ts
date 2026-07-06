import { getConfig } from '../config/index.js';
import { findEnabledTemplates, updateLastSyncAt } from '../db/queries/process-template.js';
import { getAllCorpIds } from '../db/queries/corp-config.js';
import { searchInstances, getInstance, delay } from '../dingtalk/api-client.js';
import { normalizeInstance } from '../normalize/instance-normalizer.js';
import { normalizeTasks } from '../normalize/task-normalizer.js';
import { processUserSnapshot } from '../normalize/user-snapshot.js';
import { saveFormFields } from '../normalize/form-field-extractor.js';
import { upsertInstance } from '../db/queries/approval-instance.js';
import { upsertTask } from '../db/queries/approval-task.js';
import { withTransaction } from '../db/pool.js';
import {
  createBackfillCursor,
  updateBackfillCursor,
  getRunningCursor,
} from './backfill-state.js';

// 钉钉 API 限制：40 QPS，留余量用保守值
const DELAY_BETWEEN_INSTANCES_MS = 500;  // 每条实例间隔（getInstance）
const DELAY_BETWEEN_PAGES_MS = 1000;     // 翻页间隔（searchInstances）
const CHUNK_DAYS = 7;                     // 大窗口自动切分为 7 天小窗口

export interface BackfillOptions {
  corp_id?: string;
  process_code?: string;
  window_start?: Date;
  window_end?: Date;
  delayMs?: number;       // 自定义实例间延迟（ms）
  chunkDays?: number;     // 自定义窗口切分天数
}

export async function runBackfill(params: BackfillOptions): Promise<void> {
  const config = getConfig();
  const instanceDelay = params.delayMs ?? DELAY_BETWEEN_INSTANCES_MS;
  const chunkDays = params.chunkDays ?? CHUNK_DAYS;

  let corpIds: string[];
  if (params.corp_id) {
    corpIds = [params.corp_id];
  } else {
    const corps = await getAllCorpIds();
    corpIds = corps.map(c => c.corp_id);
  }

  if (corpIds.length === 0) {
    console.warn('[Backfill] 没有找到活跃的企业 ID，请先启动服务接收事件');
    return;
  }

  const window_end = params.window_end || new Date();
  const window_start = params.window_start || new Date(window_end.getTime() - config.BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const totalDays = Math.ceil((window_end.getTime() - window_start.getTime()) / (24 * 60 * 60 * 1000));

  // 大窗口自动切分
  const chunks = splitWindow(window_start, window_end, chunkDays);

  console.log(`[Backfill] 总时间范围: ${totalDays} 天，切分为 ${chunks.length} 个子窗口（每窗口 ${chunkDays} 天）`);

  for (const corp_id of corpIds) {
    let templates;
    if (params.process_code) {
      templates = [{ corp_id, process_code: params.process_code, enabled: true, is_deleted: false }];
    } else {
      templates = await findEnabledTemplates(corp_id);
    }

    console.log(`[Backfill] 企业 ${corp_id}: ${templates.length} 个模板，共 ${chunks.length * templates.length} 个任务`);

    let templateIndex = 0;
    for (const template of templates) {
      templateIndex++;
      let totalProcessed = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkLabel = `[${templateIndex}/${templates.length}] ${template.process_code} [${i + 1}/${chunks.length}]`;

        try {
          const processed = await backfillTemplate({
            corp_id,
            process_code: template.process_code,
            window_start: chunk.start,
            window_end: chunk.end,
            delayMs: instanceDelay,
            chunkLabel,
          });
          totalProcessed += processed;
        } catch (error) {
          console.error(`[Backfill] ${chunkLabel} 失败:`, error);
        }

        // 子窗口之间休息 2 秒，避免连续请求
        if (i < chunks.length - 1) {
          await delay(2000);
        }
      }

      await updateLastSyncAt(corp_id, template.process_code);
      console.log(`[Backfill] 模板 ${template.process_code} 完成，共处理 ${totalProcessed} 条`);
    }
  }
}

function splitWindow(start: Date, end: Date, chunkDays: number): { start: Date; end: Date }[] {
  const chunks: { start: Date; end: Date }[] = [];
  const chunkMs = chunkDays * 24 * 60 * 60 * 1000;
  let current = start.getTime();
  const endMs = end.getTime();

  while (current < endMs) {
    const chunkEnd = Math.min(current + chunkMs, endMs);
    chunks.push({ start: new Date(current), end: new Date(chunkEnd) });
    current = chunkEnd;
  }

  return chunks;
}

async function backfillTemplate(params: {
  corp_id: string;
  process_code: string;
  window_start: Date;
  window_end: Date;
  delayMs: number;
  chunkLabel: string;
}): Promise<number> {
  const { corp_id, process_code, window_start, window_end, delayMs, chunkLabel } = params;

  const runningCursor = await getRunningCursor(corp_id, process_code);
  if (runningCursor) {
    console.warn(`[Backfill] ${chunkLabel} 有正在运行的任务，跳过`);
    return 0;
  }

  const cursor = await createBackfillCursor({
    corp_id,
    process_code,
    window_start,
    window_end,
  });

  try {
    let nextToken: string | undefined;
    let totalProcessed = 0;
    let pageCount = 0;
    const startTime = Date.now();

    while (true) {
      const result = await searchInstances({
        processCode: process_code,
        startTime: window_start,
        endTime: window_end,
        nextToken,
        size: 20,
      });

      pageCount++;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`[Backfill] ${chunkLabel} 第 ${pageCount} 页 | ${result.list.length} 条 | 已处理 ${totalProcessed} | ${elapsed}s`);

      for (const instance of result.list) {
        try {
          await backfillInstance(corp_id, instance.processInstanceId, process_code);
          totalProcessed++;
          await delay(delayMs);
        } catch (error) {
          console.error(`[Backfill] 实例失败: ${instance.processInstanceId}`, error);
        }
      }

      await updateBackfillCursor({
        id: cursor.id,
        cursor_offset: totalProcessed,
        processed_count: totalProcessed,
      });

      if (!result.nextToken || result.list.length === 0) break;
      nextToken = result.nextToken;

      // 翻页间隔
      await delay(DELAY_BETWEEN_PAGES_MS);
    }

    await updateBackfillCursor({
      id: cursor.id,
      status: 'completed',
      finished_at: new Date(),
      processed_count: totalProcessed,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`[Backfill] ${chunkLabel} 完成 | ${totalProcessed} 条 | ${elapsed}s`);
    return totalProcessed;
  } catch (error: any) {
    await updateBackfillCursor({
      id: cursor.id,
      status: 'failed',
      finished_at: new Date(),
      error_message: error.message,
    });
    throw error;
  }
}

async function backfillInstance(corp_id: string, processInstanceId: string, processCode?: string): Promise<void> {
  // 获取完整实例详情
  const instanceDetail = await getInstance(processInstanceId);

  // 使用事务写入所有数据
  await withTransaction(async (client) => {
    // 1. 写入审批实例
    const normalizedInstance = normalizeInstance(corp_id, instanceDetail, {
      processInstanceId,
      processCode: processCode || instanceDetail.processCode || undefined,
    });
    await upsertInstance(normalizedInstance, client);

    // 2. 写入审批任务
    if (instanceDetail.tasks && instanceDetail.tasks.length > 0) {
      const normalizedTasks = normalizeTasks(corp_id, processInstanceId, instanceDetail.tasks);

      for (const task of normalizedTasks) {
        await upsertTask(task, client);
      }
    }

    // 3. 保存表单字段元数据
    if (instanceDetail.formComponentValues) {
      await saveFormFields(corp_id, instanceDetail.processCode || processCode || '', instanceDetail.formComponentValues, client);
    }
  });

  // 4. 处理用户快照（不阻断主流程）
  if (instanceDetail.originatorId) {
    processUserSnapshot(corp_id, instanceDetail.originatorId).catch((error) => {
      console.error('[Backfill] 用户快照处理失败:', error);
    });
  }
}
