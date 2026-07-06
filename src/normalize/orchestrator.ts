import { getInstance, listProcessTemplates } from '../dingtalk/api-client.js';
import type { ApprovalInstanceDetail } from '../dingtalk/types.js';
import { upsertInstance, findAnyOriginatorUserId } from '../db/queries/approval-instance.js';
import { upsertTask } from '../db/queries/approval-task.js';
import { upsertProcessTemplate, findByCorpAndProcessCode, updateTemplateName } from '../db/queries/process-template.js';
import { insertEvent, updateEventStatus } from '../db/queries/event-log.js';
import { saveCorpId } from '../db/queries/corp-config.js';
import { withTransaction } from '../db/pool.js';
import { normalizeInstance } from './instance-normalizer.js';
import { normalizeTasks } from './task-normalizer.js';
import { processUserSnapshot } from './user-snapshot.js';
import { saveFormFields } from './form-field-extractor.js';
import type { JsonValue } from '../db/json-types.js';

export interface ProcessMessageParams {
  eventType: string;
  corpId: string;
  processInstanceId: string;
  processCode?: string;
  eventId?: string;
  payload: Record<string, unknown>;
  source: string;
  receivedAt: string;
}

/**
 * 处理审批事件消息
 * 统一入口：消息 → 拉取完整实例 → normalize → 单事务写入
 */
export async function processApprovalMessage(params: ProcessMessageParams): Promise<void> {
  const startTime = Date.now();
  let eventLog: { id: bigint; status: string } | null = null;

  try {
    // 从事件中获取并保存 corp_id
    if (params.corpId) {
      await saveCorpId(params.corpId);
    } else {
      console.warn('[Orchestrator] corpId 为空，跳过保存。事件数据:', JSON.stringify(params.payload).slice(0, 500));
    }

    // 记录事件日志（处理重复事件）
    const { event: insertedEvent, isDuplicate } = await insertEvent({
      corp_id: params.corpId,
      event_id: params.eventId,
      event_type: params.eventType,
      source: params.source,
      process_instance_id: params.processInstanceId,
      process_code: params.processCode,
      raw_event: params.payload,
    });
    eventLog = insertedEvent;

    if (isDuplicate && eventLog.status === 'success') {
      console.log(`[Orchestrator] 重复事件已处理，跳过: ${params.processInstanceId}`);
      return;
    }

    await updateEventStatus({
      id: eventLog.id,
      status: 'processing',
    });

    // 事件兜底发现审批模板
    if (params.processCode) {
      const existingTemplate = await findByCorpAndProcessCode(params.corpId, params.processCode);

      if (!existingTemplate) {
        console.log(`[Orchestrator] 自动插入新模板: ${params.processCode}`);
        // 尝试从模板列表 API 获取名称
        let templateName: string | null = null;
        try {
          const userId = await findAnyOriginatorUserId();
          if (userId) {
            const templates = await listProcessTemplates(userId);
            const matched = templates.find(t => t.processCode === params.processCode);
            if (matched) templateName = matched.name || null;
          }
        } catch (error) {
          console.warn('[Orchestrator] 获取模板名称失败，不阻断主流程:', error);
        }

        await upsertProcessTemplate({
          corp_id: params.corpId,
          process_code: params.processCode,
          name: templateName,
          enabled: true,
        });
      } else if (!existingTemplate.enabled) {
        // 模板被禁用，跳过处理
        console.log(`[Orchestrator] 模板已禁用，跳过: ${params.processCode}`);
        await updateEventStatus({
          id: eventLog.id,
          status: 'skipped',
          processed_at: new Date(),
          duration_ms: Date.now() - startTime,
        });
        return;
      }
    }

    // 获取完整实例详情
    let instanceDetail: ApprovalInstanceDetail;
    try {
      instanceDetail = await getInstance(params.processInstanceId);
    } catch (apiError: any) {
      // API 调用或 Zod 验证失败时，记录详细错误
      const errorDetail = apiError.name === 'ZodError'
        ? JSON.stringify(apiError.errors, null, 2)
        : apiError.message;
      throw new Error(`getInstance 失败: ${errorDetail}`);
    }

    // 使用事务写入所有数据
    await withTransaction(async (client) => {
      // 1. 写入审批实例
      const normalizedInstance = normalizeInstance(params.corpId, instanceDetail, {
        processInstanceId: params.processInstanceId,
        processCode: params.processCode,
        originatorUserId: (params.payload?.staffId || params.payload?.StaffId) as string | undefined,
      });
      await upsertInstance(normalizedInstance, client);

      // 2. 写入审批任务
      if (instanceDetail.tasks && instanceDetail.tasks.length > 0) {
        const normalizedTasks = normalizeTasks(
          params.corpId,
          params.processInstanceId,
          instanceDetail.tasks
        );

        for (const task of normalizedTasks) {
          await upsertTask(task, client);
        }
      }

      // 3. 保存表单字段元数据
      if (instanceDetail.formComponentValues) {
        await saveFormFields(
          params.corpId,
          instanceDetail.processCode || params.processCode || '',
          instanceDetail.formComponentValues,
          client
        );
      }
    });

    // 4. 处理用户快照（不阻断主流程）
    // 优先用 API 返回的 originatorId，兜底用事件中的 staffId
    const originatorId = instanceDetail.originatorId
      || (params.payload?.staffId as string | undefined)
      || (params.payload?.StaffId as string | undefined);
    if (originatorId) {
      processUserSnapshot(params.corpId, originatorId).catch((error) => {
        console.error('[Orchestrator] 用户快照处理失败:', error);
      });
    }

    // 更新事件日志为成功
    await updateEventStatus({
      id: eventLog.id,
      status: 'success',
      processed_at: new Date(),
      duration_ms: Date.now() - startTime,
    });

    const actionType = params.payload?.type || params.payload?.Type || params.eventType;
    console.log(`[Orchestrator] 消息处理成功: ${params.processInstanceId} (${actionType})`);
  } catch (error: any) {
    const actionType = params.payload?.type || params.payload?.Type || params.eventType;
    console.error(`[Orchestrator] 消息处理失败: ${params.processInstanceId} (${actionType})`, error);

    // 更新事件日志为失败（确保 error_message 是合法字符串）
    if (eventLog) {
      const errorMsg = error.name === 'ZodError'
        ? JSON.stringify(error.errors)
        : String(error.message || error);
      await updateEventStatus({
        id: eventLog.id,
        status: 'failed',
        processed_at: new Date(),
        duration_ms: Date.now() - startTime,
        error_message: errorMsg.slice(0, 2000), // 截断防止超长
      });
    }

    throw error;
  }
}
