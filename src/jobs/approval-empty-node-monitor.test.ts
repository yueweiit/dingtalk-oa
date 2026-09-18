import { describe, expect, it, vi } from 'vitest';
import { findEmptyApprovalNodes, monitorEmptyApprovalNodesForInstance } from './approval-empty-node-monitor.js';

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    APPROVAL_EMPTY_NODE_PROCESS_CODES: 'PROC-DYNAMIC',
    DINGTALK_ALERT_RECIPIENT_USER_IDS: 'receiver-1',
  }),
}));

const forecastBase = {
  isForecastSuccess: true,
  isStaticWorkflow: false,
  workflowForecastNodes: [
    { activityId: 'start' },
    { activityId: 'approval-empty' },
    { activityId: 'end' },
  ],
};

describe('approval empty node monitor', () => {
  it('finds an empty node in a static workflow', () => {
    expect(findEmptyApprovalNodes({
      isForecastSuccess: true,
      isStaticWorkflow: true,
      workflowActivityRules: [{
        activityId: 'static-empty', activityName: '直属主管审批', activityType: 'target_approval',
        isTargetSelect: false, activityActioners: [],
      }],
    })).toEqual([{ activityId: 'static-empty', activityName: '直属主管审批' }]);
  });

  it('recognizes DingTalk target_label nodes whose actor is an approver', () => {
    expect(findEmptyApprovalNodes({
      isForecastSuccess: true,
      isStaticWorkflow: true,
      workflowForecastNodes: [{ activityId: 'label-empty' }],
      workflowActivityRules: [{
        activityId: 'label-empty', activityName: '测试', activityType: 'target_label',
        isTargetSelect: false, activityActioners: [], workflowActor: { actorType: 'approver' },
      }],
    })).toEqual([{ activityId: 'label-empty', activityName: '测试' }]);
  });

  it('finds only empty automatic approval nodes on the selected dynamic path', () => {
    expect(findEmptyApprovalNodes({
      ...forecastBase,
      workflowActivityRules: [
        { activityId: 'approval-empty', activityName: '财务审批', activityType: 'target_approval', isTargetSelect: false, activityActioners: [] },
        { activityId: 'other-branch', activityName: '未命中分支', activityType: 'target_approval', isTargetSelect: false, activityActioners: [] },
        { activityId: 'self-select', activityName: '发起人自选', activityType: 'target_approval', isTargetSelect: true, activityActioners: [], workflowActor: { required: false } },
      ],
    })).toEqual([{ activityId: 'approval-empty', activityName: '财务审批' }]);
  });

  it('does not report an approval node that has an approver', () => {
    expect(findEmptyApprovalNodes({
      ...forecastBase,
      workflowActivityRules: [{
        activityId: 'approval-empty', activityName: '财务审批', activityType: 'target_approval',
        isTargetSelect: false, activityActioners: [{ userId: 'user-1', name: '审批人' }],
      }],
    })).toEqual([]);
  });

  it('sends one deduplicated alert for an empty node', async () => {
    const claimDelivery = vi.fn().mockResolvedValue(true);
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await monitorEmptyApprovalNodesForInstance('corp-1', {
      processInstanceId: 'instance-1', processCode: 'PROC-DYNAMIC', title: '采购申请', status: 'RUNNING',
      originatorUserId: 'starter-1', originatorDeptId: '123', formComponentValues: [{ name: '类型', value: '采购' }],
    }, {
      forecast: vi.fn().mockResolvedValue({
        ...forecastBase,
        workflowActivityRules: [{
          activityId: 'approval-empty', activityName: '财务审批', activityType: 'target_approval',
          isTargetSelect: false, activityActioners: [],
        }],
      }),
      claimDelivery,
      markSent: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      send,
    });

    expect(result.status).toBe('empty_nodes_found');
    expect(result.sent).toBe(1);
    expect(claimDelivery).toHaveBeenCalledWith(expect.objectContaining({
      alertType: 'empty_approver_node', alertPhase: 'approval-empty', recipientUserId: 'receiver-1',
    }), expect.any(Object));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
