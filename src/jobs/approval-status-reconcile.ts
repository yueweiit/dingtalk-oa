import { findRunningApprovalInstances } from '../db/queries/approval-instance.js';
import { refreshApprovalInstance } from '../normalize/orchestrator.js';
import { delay } from '../dingtalk/api-client.js';
import type { DingApprovalInstance } from '../db/types.js';

export interface ApprovalStatusReconcileOptions {
  limit: number;
  delayMs: number;
}

export interface ApprovalStatusReconcileResult {
  scanned: number;
  changed: number;
  unchanged: number;
  failed: number;
}

export interface ApprovalStatusReconcileDependencies {
  findRunningInstances: (limit: number) => Promise<DingApprovalInstance[]>;
  refreshInstance: (params: {
    corpId: string;
    processInstanceId: string;
    processCode?: string;
    originatorUserId?: string;
  }) => Promise<{ status?: string | null; result?: string | null }>;
  wait: (milliseconds: number) => Promise<void>;
}

const defaultDependencies: ApprovalStatusReconcileDependencies = {
  findRunningInstances: findRunningApprovalInstances,
  refreshInstance: refreshApprovalInstance,
  wait: delay,
};

/**
 * Kafka 事件漏达时的兜底：仅核对本地仍处于审批中的实例。
 */
export async function reconcileRunningApprovalStatuses(
  options: ApprovalStatusReconcileOptions,
  dependencies: ApprovalStatusReconcileDependencies = defaultDependencies
): Promise<ApprovalStatusReconcileResult> {
  const instances = await dependencies.findRunningInstances(options.limit);
  const result: ApprovalStatusReconcileResult = {
    scanned: instances.length,
    changed: 0,
    unchanged: 0,
    failed: 0,
  };

  if (instances.length === 0) {
    console.log('[StatusReconcile] 没有待核对的审批中实例');
    return result;
  }

  console.log(`[StatusReconcile] 开始核对 ${instances.length} 条审批中实例`);

  for (const instance of instances) {
    try {
      const detail = await dependencies.refreshInstance({
        corpId: instance.corp_id,
        processInstanceId: instance.process_instance_id,
        processCode: instance.process_code,
        originatorUserId: instance.originator_user_id ?? undefined,
      });

      if (detail.status !== instance.status || detail.result !== instance.result) {
        result.changed++;
        console.log(
          `[StatusReconcile] 状态已更新: ${instance.process_instance_id} ` +
          `${instance.status}/${instance.result ?? ''} -> ${detail.status ?? ''}/${detail.result ?? ''}`
        );
      } else {
        result.unchanged++;
      }
    } catch (error) {
      result.failed++;
      console.error(`[StatusReconcile] 核对失败: ${instance.process_instance_id}`, error);
    }

    if (options.delayMs > 0) {
      await dependencies.wait(options.delayMs);
    }
  }

  console.log(
    `[StatusReconcile] 完成: 扫描 ${result.scanned}，状态变化 ${result.changed}，` +
    `未变化 ${result.unchanged}，失败 ${result.failed}`
  );
  return result;
}
