import { getConfig } from '../config/index.js';
import {
  claimAlertDelivery,
  markAlertDeliveryFailed,
  markAlertDeliverySent,
  type AlertDeliveryKey,
} from '../db/queries/alert-notification.js';
import { forecastProcess } from '../dingtalk/api-client.js';
import { sendAlertChatMessage } from '../dingtalk/alert-robot.js';
import type { ApprovalInstanceDetail, ProcessForecastResult } from '../dingtalk/types.js';

const ALERT_TYPE = 'empty_approver_node';

export interface EmptyApprovalNode {
  activityId: string;
  activityName: string;
}

export interface ApprovalEmptyNodeMonitorDependencies {
  forecast: typeof forecastProcess;
  claimDelivery: (key: AlertDeliveryKey, payload: Record<string, unknown>) => Promise<boolean>;
  markSent: (key: AlertDeliveryKey) => Promise<void>;
  markFailed: (key: AlertDeliveryKey, error: string) => Promise<void>;
  send: (userIds: string[], content: string) => Promise<void>;
}

const defaultDependencies: ApprovalEmptyNodeMonitorDependencies = {
  forecast: forecastProcess,
  claimDelivery: claimAlertDelivery,
  markSent: markAlertDeliverySent,
  markFailed: markAlertDeliveryFailed,
  send: sendAlertChatMessage,
};

function parseList(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
}

export function findEmptyApprovalNodes(forecast: ProcessForecastResult): EmptyApprovalNode[] {
  if (!forecast.isForecastSuccess) return [];
  const pathIds = new Set((forecast.workflowForecastNodes ?? [])
    .map((node) => node.activityId)
    .filter((id): id is string => Boolean(id)));

  return (forecast.workflowActivityRules ?? []).flatMap((rule) => {
    const activityId = String(rule.activityId ?? '').trim();
    const activityType = String(rule.activityType ?? '').toLowerCase();
    if (!activityId || (pathIds.size > 0 && !pathIds.has(activityId))) return [];
    const actorType = String(rule.workflowActor?.actorType ?? '').toLowerCase();
    if (!activityType.includes('approval') && actorType !== 'approver') return [];
    // 自选审批人由发起人提交时选择，预测接口不会稳定回传其最终人选，不能按空节点误报。
    if (rule.isTargetSelect) return [];
    const hasApprover = (rule.activityActioners ?? []).some((actioner) => Boolean(actioner.userId?.trim()));
    if (hasApprover) return [];
    return [{ activityId, activityName: String(rule.activityName ?? '').trim() || '未命名审批节点' }];
  });
}

export async function monitorEmptyApprovalNodesForInstance(
  corpId: string,
  detail: ApprovalInstanceDetail,
  dependencies: ApprovalEmptyNodeMonitorDependencies = defaultDependencies,
): Promise<{ status: string; sent: number; emptyNodes: EmptyApprovalNode[]; reason?: string }> {
  if (String(detail.status).toUpperCase() !== 'RUNNING') {
    return { status: 'skipped', sent: 0, emptyNodes: [], reason: 'not_running' };
  }
  const config = getConfig();
  const processCode = String(detail.processCode ?? '').trim();
  if (!parseList(config.APPROVAL_EMPTY_NODE_PROCESS_CODES).includes(processCode)) {
    return { status: 'skipped', sent: 0, emptyNodes: [], reason: 'process_not_configured' };
  }
  const processInstanceId = String(detail.processInstanceId ?? '').trim();
  const userId = String(detail.originatorUserId ?? detail.originatorId ?? '').trim();
  const deptId = Number(detail.originatorDeptId);
  if (!processInstanceId || !userId || !Number.isFinite(deptId)) {
    return { status: 'skipped', sent: 0, emptyNodes: [], reason: 'forecast_input_missing' };
  }
  const recipients = parseList(config.DINGTALK_ALERT_RECIPIENT_USER_IDS);
  if (!recipients.length) {
    return { status: 'skipped', sent: 0, emptyNodes: [], reason: 'notification_not_configured' };
  }

  const forecast = await dependencies.forecast({
    processCode,
    userId,
    deptId,
    formComponentValues: detail.formComponentValues ?? [],
  });
  if (!forecast.isForecastSuccess) {
    return { status: 'forecast_failed', sent: 0, emptyNodes: [], reason: 'forecast_unsuccessful' };
  }
  const emptyNodes = findEmptyApprovalNodes(forecast);
  if (!emptyNodes.length) return { status: 'ok', sent: 0, emptyNodes };

  const approvalUrl = `https://applink.dingtalk.com/approval/detail?corpId=${encodeURIComponent(corpId)}&instanceId=${encodeURIComponent(processInstanceId)}`;
  let sent = 0;
  for (const node of emptyNodes) {
    const content = [
      '【审批节点无人】',
      `流程：${detail.title || processCode}`,
      `节点：${node.activityName}`,
      '原因：该节点已命中本次实际审批路径，但没有解析到审批人，请检查流程配置。',
      `审批单：${approvalUrl}`,
    ].join('\n');
    for (const recipientUserId of recipients) {
      const key: AlertDeliveryKey = {
        corpId,
        processInstanceId,
        alertType: ALERT_TYPE,
        alertPhase: node.activityId,
        recipientUserId,
      };
      const claimed = await dependencies.claimDelivery(key, { processCode, ...node });
      if (!claimed) continue;
      try {
        await dependencies.send([recipientUserId], content);
        await dependencies.markSent(key);
        sent++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await dependencies.markFailed(key, message);
        console.error(`[EmptyApprovalNode] 发送失败: ${processInstanceId}/${node.activityId}`, message);
      }
    }
  }
  return { status: 'empty_nodes_found', sent, emptyNodes };
}
