import { findRunningApprovalInstances } from '../db/queries/approval-instance.js';
import { refreshApprovalInstance } from '../normalize/orchestrator.js';
import { delay, InvalidApprovalInstanceIdError } from '../dingtalk/api-client.js';
import type { DingApprovalInstance } from '../db/types.js';

interface ApprovalInstanceRef {
  corpId: string;
  processInstanceId: string;
}

export interface ApprovalStatusReconcileOptions {
  limit: number;
  delayMs: number;
  invalidIdCooldownMinutes: number;
}

export interface ApprovalStatusReconcileResult {
  scanned: number;
  changed: number;
  unchanged: number;
  failed: number;
}

export interface ApprovalStatusReconcileDependencies {
  findRunningInstances: (limit: number, coolingDown: readonly ApprovalInstanceRef[]) => Promise<DingApprovalInstance[]>;
  refreshInstance: (params: ApprovalInstanceRef & {
    processCode?: string;
    originatorUserId?: string;
  }) => Promise<{ status?: string | null; result?: string | null }>;
  wait: (milliseconds: number) => Promise<void>;
  now: () => number;
}

const defaultDependencies: ApprovalStatusReconcileDependencies = {
  findRunningInstances: findRunningApprovalInstances,
  refreshInstance: refreshApprovalInstance,
  wait: delay,
  now: Date.now,
};

/**
 * Kafka 事件漏达时的兜底：仅核对本地仍处于审批中的实例。
 */
export function createApprovalStatusReconciler(dependencies: ApprovalStatusReconcileDependencies = defaultDependencies) {
  const cooldowns = new Map<string, ApprovalInstanceRef & { retryAt: number }>();

  return async (options: ApprovalStatusReconcileOptions): Promise<ApprovalStatusReconcileResult> => {
    const now = dependencies.now();
    const coolingDown: ApprovalInstanceRef[] = [];
    for (const [key, { corpId, processInstanceId, retryAt }] of cooldowns) {
      if (retryAt <= now) cooldowns.delete(key);
      else coolingDown.push({ corpId, processInstanceId });
    }

    const instances = await dependencies.findRunningInstances(options.limit, coolingDown);
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
      const ref = { corpId: instance.corp_id, processInstanceId: instance.process_instance_id };
      try {
        const detail = await dependencies.refreshInstance({
          ...ref,
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
        if (error instanceof Error && error.cause instanceof InvalidApprovalInstanceIdError) {
          const retryAt = dependencies.now() + options.invalidIdCooldownMinutes * 60_000;
          cooldowns.set(JSON.stringify([ref.corpId, ref.processInstanceId]), { ...ref, retryAt });
          console.warn('[StatusReconcile] processInstanceIdError，暂停状态核对', { ...ref, retryAt: new Date(retryAt).toISOString() });
        } else {
          console.error(`[StatusReconcile] 核对失败: ${instance.process_instance_id}`, error);
        }
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
  };
}

export const reconcileRunningApprovalStatuses = createApprovalStatusReconciler();
