import { describe, expect, it, vi } from 'vitest';
import { monitorApprovalTimeouts } from './approval-timeout-monitor.js';

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    DINGTALK_ALERT_RECIPIENT_USER_IDS: 'receiver-1',
    APPROVAL_TIMEOUT_PROCESS_CODES: 'PROC-TEST',
    APPROVAL_TIMEOUT_WINDOW_BEFORE_MINUTES: 31,
    APPROVAL_TIMEOUT_WINDOW_AFTER_MINUTES: 31,
    APPROVAL_TIMEOUT_MINUTES: 24 * 60,
  }),
}));

describe('monitorApprovalTimeouts', () => {
  it('sends each timeout phase once and records the delivery key', async () => {
    const claimDelivery = vi.fn().mockResolvedValue(true);
    const markSent = vi.fn().mockResolvedValue(undefined);
    const result = await monitorApprovalTimeouts({
      now: () => new Date('2026-09-15T04:00:00.000Z'),
      findCandidates: vi.fn().mockResolvedValue([{
        corpId: 'corp-1',
        processInstanceId: 'instance-1',
        processCode: 'PROC-TEST',
        title: '测试采购审批',
        taskId: 'task-1',
        nodeName: '部门主管审批',
        approverUserId: 'approver-1',
        approverUserName: '张三',
        taskStartTime: new Date('2026-09-14T04:10:00.000Z'),
        rawTask: {},
        rawInstance: {},
      }]),
      claimDelivery,
      markSent,
      markFailed: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    });

    expect(result).toEqual({ scanned: 1, eligible: 1, sent: 1, failed: 0 });
    expect(claimDelivery).toHaveBeenCalledWith(expect.objectContaining({
      alertType: 'approval_timeout',
      alertPhase: 'before:task-1',
      recipientUserId: 'approver-1',
    }), expect.objectContaining({ phase: 'before' }));
    expect(result.sent).toBe(1);
    expect(claimDelivery).toHaveBeenCalledWith(expect.objectContaining({ recipientUserId: 'approver-1' }), expect.objectContaining({ approverUserId: 'approver-1' }));
    expect(markSent).toHaveBeenCalledTimes(1);
  });

  it('skips a timeout notification when the running task has no approver userid', async () => {
    const claimDelivery = vi.fn().mockResolvedValue(true);
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await monitorApprovalTimeouts({
      now: () => new Date('2026-09-15T04:00:00.000Z'),
      findCandidates: vi.fn().mockResolvedValue([{
        corpId: 'corp-1',
        processInstanceId: 'instance-2',
        processCode: 'PROC-TEST',
        title: '缺少审批人测试',
        taskId: 'task-2',
        nodeName: '财务审批',
        approverUserId: null,
        approverUserName: null,
        taskStartTime: new Date('2026-09-14T04:10:00.000Z'),
        rawTask: {},
        rawInstance: {},
      }]),
      claimDelivery,
      markSent: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      send,
    });

    expect(result).toEqual({ scanned: 1, eligible: 1, sent: 0, failed: 0 });
    expect(claimDelivery).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
