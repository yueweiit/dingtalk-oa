import { getConfig } from '../config/index.js';
import { getInstance } from '../dingtalk/api-client.js';
import {
  claimNextApprovalRepairRequest,
  markApprovalRepairFailure,
  markApprovalRepairSuccess,
  type ApprovalRepairRequest,
} from '../db/queries/approval-repair.js';
import { persistApprovalInstance } from '../normalize/orchestrator.js';
import { extractAttachmentCandidates } from '../archive/attachment-extractor.js';
import { upsertAttachmentCandidates } from '../db/queries/attachment-archive.js';
import type { ApprovalInstanceDetail } from '../dingtalk/types.js';

export type { ApprovalRepairRequest } from '../db/queries/approval-repair.js';

export interface ApprovalRepairDependencies {
  fetchInstance: (processInstanceId: string) => Promise<ApprovalInstanceDetail>;
  persistInstance: typeof persistApprovalInstance;
  enqueueAttachments: (
    request: ApprovalRepairRequest,
    detail: ApprovalInstanceDetail,
  ) => Promise<void>;
  markSuccess: typeof markApprovalRepairSuccess;
  markFailure: typeof markApprovalRepairFailure;
}

function repairError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function retryable(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : String(error);
  const text = `${code} ${message}`.toLowerCase();
  if (text.includes('not_found') || text.includes('not found') || text.includes('permission')
      || text.includes('forbidden') || text.includes('mismatch') || text.includes('invalid')) return false;
  return text.includes('429') || text.includes('timeout') || text.includes('timedout')
    || text.includes('network') || text.includes('econn') || text.includes('http 5');
}

export async function processApprovalRepairRequest(
  request: ApprovalRepairRequest,
  dependencies: ApprovalRepairDependencies,
): Promise<void> {
  try {
    const detail = await dependencies.fetchInstance(request.processInstanceId);
    const instanceId = String(detail.processInstanceId || '').trim();
    const businessId = String(detail.businessId || '').trim();
    const processCode = String(detail.processCode || '').trim();
    // Older workflow detail responses do not always echo processInstanceId.
    // The endpoint itself is addressed by the requested ID, so only reject an
    // explicit conflicting value; businessId and processCode remain mandatory.
    if (instanceId && instanceId !== request.processInstanceId) {
      throw repairError('instance_id_mismatch', '钉钉返回的流程实例 ID 与修复请求不一致');
    }
    if (businessId !== request.expectedBusinessId) {
      throw repairError('business_id_mismatch', '钉钉返回的审批编号与综合成本记录不一致');
    }
    if (processCode !== request.expectedProcessCode) {
      throw repairError('process_code_mismatch', '钉钉返回的流程模板与白名单模板不一致');
    }
    await dependencies.persistInstance({
      corpId: request.corpId,
      processInstanceId: request.processInstanceId,
      processCode: request.expectedProcessCode,
    }, detail);
    await dependencies.enqueueAttachments(request, detail);
    await dependencies.markSuccess(request.id, {
      fetchedBusinessId: businessId,
      fetchedProcessCode: processCode,
    });
  } catch (error) {
    await dependencies.markFailure(request.id, error, retryable(error));
    throw error;
  }
}

const runtimeDependencies: ApprovalRepairDependencies = {
  // 队列自身最多尝试 3 次，每次只发起一次实例请求。
  fetchInstance: (processInstanceId) => getInstance(processInstanceId, { retries: 0 }),
  persistInstance: persistApprovalInstance,
  enqueueAttachments: async (request, detail) => {
    if (request.expectedPurpose !== 'international_logistics') return;
    const candidates = extractAttachmentCandidates({
      corpId: request.corpId,
      processInstanceId: request.processInstanceId,
      processCode: request.expectedProcessCode,
      rawPayload: detail,
    });
    await upsertAttachmentCandidates(candidates);
  },
  markSuccess: markApprovalRepairSuccess,
  markFailure: markApprovalRepairFailure,
};

let interval: NodeJS.Timeout | null = null;
let running = false;

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const request = await claimNextApprovalRepairRequest();
    if (!request) return;
    await processApprovalRepairRequest(request, runtimeDependencies);
  } catch (error) {
    console.error('[ApprovalRepair] 审批补同步失败:', error);
  } finally {
    running = false;
  }
}

export function startApprovalRepairWorker(): void {
  if (interval) return;
  const pollMs = getConfig().APPROVAL_REPAIR_POLL_MS;
  interval = setInterval(() => void runOnce(), pollMs);
  interval.unref();
  void runOnce();
}

export function stopApprovalRepairWorker(): void {
  if (interval) clearInterval(interval);
  interval = null;
}
