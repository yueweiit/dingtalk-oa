import {
  claimCompletedApprovalRefresh, finishCompletedApprovalRefresh,
  type CompletedApprovalRefreshInstance,
} from '../db/queries/approval-instance.js';
import { refreshApprovalInstance, type RefreshApprovalInstanceParams } from '../normalize/orchestrator.js';
import { delay } from '../dingtalk/api-client.js';

export interface CompletedApprovalRefreshOptions {
  limit: number;
  delayMs: number;
  minIntervalSeconds: number;
}

export interface CompletedApprovalRefreshDependencies {
  claim: (limit: number, minIntervalSeconds: number) => Promise<CompletedApprovalRefreshInstance[]>;
  refresh: (params: RefreshApprovalInstanceParams) => Promise<unknown>;
  finish: (instance: CompletedApprovalRefreshInstance, error?: unknown) => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
}

const defaultDependencies: CompletedApprovalRefreshDependencies = {
  claim: claimCompletedApprovalRefresh,
  refresh: refreshApprovalInstance,
  finish: finishCompletedApprovalRefresh,
  wait: delay,
};

/** Comments and payment attachments can change after the approval is completed. */
export async function refreshCompletedLogisticsApprovals(
  options: CompletedApprovalRefreshOptions,
  dependencies: CompletedApprovalRefreshDependencies = defaultDependencies,
): Promise<{ scanned: number; refreshed: number; failed: number }> {
  const instances = await dependencies.claim(options.limit, options.minIntervalSeconds);
  const result = { scanned: instances.length, refreshed: 0, failed: 0 };
  for (let index = 0; index < instances.length; index++) {
    const instance = instances[index];
    let refreshError: unknown;
    try {
      // Shared API retries, usage tracking, normalization and transactional manifest synchronization.
      await dependencies.refresh({
        corpId: instance.corp_id, processInstanceId: instance.process_instance_id,
        processCode: instance.process_code, originatorUserId: instance.originator_user_id ?? undefined,
      });
      result.refreshed++;
    } catch (error) {
      refreshError = error ?? new Error('Unknown approval refresh error');
      result.failed++;
      console.error(`[CompletedRefresh] 刷新失败: ${instance.process_instance_id}`, error);
    }
    try {
      if (refreshError === undefined) await dependencies.finish(instance);
      else await dependencies.finish(instance, refreshError);
    } catch (error) {
      // The durable claim has already advanced. A failed ledger write cannot starve later rows.
      console.error(`[CompletedRefresh] 保存检查结果失败: ${instance.process_instance_id}`, error);
    }
    if (index + 1 < instances.length && options.delayMs > 0) await dependencies.wait(options.delayMs);
  }
  return result;
}
