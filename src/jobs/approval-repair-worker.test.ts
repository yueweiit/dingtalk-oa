import { describe, expect, it, vi } from 'vitest';

import {
  processApprovalRepairRequest,
  type ApprovalRepairDependencies,
  type ApprovalRepairRequest,
} from './approval-repair-worker.js';

const request: ApprovalRepairRequest = {
  id: 7,
  corpId: 'CORP-1',
  processInstanceId: 'INSTANCE-1',
  expectedBusinessId: '202603251357000130846',
  expectedProcessCode: 'PROC-LOGISTICS',
  expectedPurpose: 'international_logistics',
  attempts: 1,
};

function dependencies(overrides: Partial<ApprovalRepairDependencies> = {}): ApprovalRepairDependencies {
  return {
    fetchInstance: vi.fn().mockResolvedValue({
      processInstanceId: 'INSTANCE-1',
      businessId: '202603251357000130846',
      processCode: 'PROC-LOGISTICS',
      status: 'RUNNING',
    }),
    persistInstance: vi.fn().mockResolvedValue(undefined),
    enqueueAttachments: vi.fn().mockResolvedValue(undefined),
    markSuccess: vi.fn().mockResolvedValue(undefined),
    markFailure: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('approval repair worker', () => {
  it('persists a valid instance through the normal approval transaction', async () => {
    const deps = dependencies();

    await processApprovalRepairRequest(request, deps);

    expect(deps.persistInstance).toHaveBeenCalledWith({
      corpId: 'CORP-1',
      processInstanceId: 'INSTANCE-1',
      processCode: 'PROC-LOGISTICS',
    }, expect.objectContaining({ businessId: '202603251357000130846' }));
    expect(deps.markSuccess).toHaveBeenCalledWith(7, expect.objectContaining({
      fetchedBusinessId: '202603251357000130846',
      fetchedProcessCode: 'PROC-LOGISTICS',
    }));
    expect(deps.enqueueAttachments).toHaveBeenCalledTimes(1);
    expect(deps.markFailure).not.toHaveBeenCalled();
  });

  it.each([
    ['instance id', { processInstanceId: 'OTHER', businessId: request.expectedBusinessId, processCode: request.expectedProcessCode }, 'instance_id_mismatch'],
    ['business id', { processInstanceId: request.processInstanceId, businessId: 'OTHER', processCode: request.expectedProcessCode }, 'business_id_mismatch'],
    ['process template', { processInstanceId: request.processInstanceId, businessId: request.expectedBusinessId, processCode: 'OTHER' }, 'process_code_mismatch'],
  ])('rejects a mismatched %s without writing approval data', async (_label, detail, expectedCode) => {
    const deps = dependencies({ fetchInstance: vi.fn().mockResolvedValue({ ...detail, status: 'RUNNING' }) });

    await expect(processApprovalRepairRequest(request, deps)).rejects.toMatchObject({ code: expectedCode });

    expect(deps.persistInstance).not.toHaveBeenCalled();
    expect(deps.enqueueAttachments).not.toHaveBeenCalled();
    expect(deps.markFailure).toHaveBeenCalledWith(7, expect.objectContaining({ code: expectedCode }), false);
  });

  it('retries transient DingTalk failures but sends permanent failures to manual review', async () => {
    const timeout = Object.assign(new Error('network timeout'), { code: 'ETIMEDOUT' });
    const transient = dependencies({ fetchInstance: vi.fn().mockRejectedValue(timeout) });
    await expect(processApprovalRepairRequest(request, transient)).rejects.toThrow('network timeout');
    expect(transient.markFailure).toHaveBeenCalledWith(7, timeout, true);

    const denied = Object.assign(new Error('approval instance not found'), { code: 'not_found' });
    const permanent = dependencies({ fetchInstance: vi.fn().mockRejectedValue(denied) });
    await expect(processApprovalRepairRequest(request, permanent)).rejects.toThrow('not found');
    expect(permanent.markFailure).toHaveBeenCalledWith(7, denied, false);
  });
});
