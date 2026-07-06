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

const DELAY_BETWEEN_REQUESTS_MS = 200;
const MAX_INSTANCES_PER_WINDOW = 10000;

export async function runBackfill(params: {
  corp_id?: string;
  process_code?: string;
  window_start?: Date;
  window_end?: Date;
}): Promise<void> {
  const config = getConfig();

  // 如果未指定 corp_id，从数据库获取所有活跃的企业
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

  for (const corp_id of corpIds) {
    // 获取要处理的模板列表
    let templates;
    if (params.process_code) {
      templates = [{ corp_id, process_code: params.process_code, enabled: true, is_deleted: false }];
    } else {
      templates = await findEnabledTemplates(corp_id);
    }

    console.log(`[Backfill] 开始补数据，共 ${templates.length} 个模板`);

    for (const template of templates) {
      try {
        await backfillTemplate({
          corp_id,
          process_code: template.process_code,
          window_start: params.window_start,
          window_end: params.window_end,
        });

        // 更新最后同步时间
        await updateLastSyncAt(corp_id, template.process_code);
      } catch (error) {
        console.error(`[Backfill] 模板补数据失败: ${template.process_code}`, error);
      }
    }

    console.log('[Backfill] 补数据完成');
  }
}

async function backfillTemplate(params: {
  corp_id: string;
  process_code: string;
  window_start?: Date;
  window_end?: Date;
}): Promise<void> {
  const config = getConfig();
  const { corp_id, process_code } = params;

  // 检查是否有正在运行的任务
  const runningCursor = await getRunningCursor(corp_id, process_code);
  if (runningCursor) {
    console.warn(`[Backfill] 模板 ${process_code} 有正在运行的补数据任务，跳过`);
    return;
  }

  // 计算时间窗口
  const window_end = params.window_end || new Date();
  const window_start = params.window_start || new Date(window_end.getTime() - config.BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // 创建游标
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

    while (true) {
      // 搜索审批实例
      const result = await searchInstances({
        processCode: process_code,
        startTime: window_start,
        endTime: window_end,
        nextToken,
        size: 20,
      });

      pageCount++;
      console.log(`[Backfill] 模板 ${process_code}: 第 ${pageCount} 页，获取到 ${result.list.length} 条记录`);

      // 处理每条记录
      for (const instance of result.list) {
        try {
          await backfillInstance(corp_id, instance.processInstanceId, process_code);
          totalProcessed++;

          // 防限流延迟
          await delay(DELAY_BETWEEN_REQUESTS_MS);
        } catch (error) {
          console.error(`[Backfill] 实例处理失败: ${instance.processInstanceId}`, error);
        }
      }

      // 更新游标
      await updateBackfillCursor({
        id: cursor.id,
        cursor_offset: totalProcessed,
        processed_count: totalProcessed,
      });

      // 检查是否还有更多数据
      if (!result.nextToken || result.list.length === 0) {
        break;
      }

      nextToken = result.nextToken;

      // 检查是否超出单窗口最大数量
      if (totalProcessed >= MAX_INSTANCES_PER_WINDOW) {
        console.warn(`[Backfill] 模板 ${process_code}: 达到单窗口最大数量 ${MAX_INSTANCES_PER_WINDOW}`);
        break;
      }
    }

    // 标记完成
    await updateBackfillCursor({
      id: cursor.id,
      status: 'completed',
      finished_at: new Date(),
      processed_count: totalProcessed,
    });

    console.log(`[Backfill] 模板 ${process_code} 补数据完成，共处理 ${totalProcessed} 条`);
  } catch (error: any) {
    // 标记失败
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
