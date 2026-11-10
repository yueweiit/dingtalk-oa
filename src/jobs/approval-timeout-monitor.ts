import { createHash } from 'node:crypto';
import { getConfig } from '../config/index.js';
import { withClient } from '../db/pool.js';
import {
  claimAlertDelivery,
  markAlertDeliveryFailed,
  markAlertDeliverySent,
  type AlertDeliveryKey,
} from '../db/queries/alert-notification.js';
import { sendAlertChatMessage, sendAlertGroupMessage } from '../dingtalk/alert-robot.js';
import { parseDingTalkTime } from '../normalize/instance-normalizer.js';
import { buildApprovalTimeoutMessage } from './approval-timeout-message.js';

const ALERT_TYPE = 'approval_timeout';
const REPEAT_MINUTES = 24 * 60;

export interface ApprovalTimeoutCandidate {
  corpId: string;
  processInstanceId: string;
  processCode: string;
  title: string | null;
  taskId: string;
  taskStartTime: Date | null;
  approverUserId: string | null;
  approverUserName: string | null;
  nodeName: string | null;
  rawTask: unknown;
  rawInstance: unknown;
}

export interface ApprovalTimeoutMonitorDependencies {
  now: () => Date;
  findCandidates: (processCodes: string[], corpId: string) => Promise<ApprovalTimeoutCandidate[]>;
  claimDelivery: (key: AlertDeliveryKey, payload: Record<string, unknown>) => Promise<boolean>;
  markSent: (key: AlertDeliveryKey) => Promise<void>;
  markFailed: (key: AlertDeliveryKey, error: string) => Promise<void>;
  send: (userIds: string[], content: string) => Promise<void>;
  sendGroup: (conversationId: string, content: string, mentionUserIds: string[]) => Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function currentNodeStart(candidate: ApprovalTimeoutCandidate): Date | null {
  if (candidate.taskStartTime) return candidate.taskStartTime;
  const task = asRecord(candidate.rawTask);
  // 只用当前任务时间；整单发起时间/其他人的操作时间不能证明当前节点已等待 72 小时。
  return parseDingTalkTime(task.startTime) ?? parseDingTalkTime(task.createTime);
}

function parseList(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function currentTaskSnapshot(candidate: ApprovalTimeoutCandidate): {
  task: Record<string, unknown>;
  authoritative: boolean;
} | null {
  // 归档只 upsert 任务；最新详情可能已移除转交/或签结束后的旧任务。
  const tasks = asRecord(candidate.rawInstance).tasks;
  if (Array.isArray(tasks)) {
    const task = tasks.map(asRecord).find((item, index) => (
      item.taskId ?? `task_${candidate.processInstanceId}_${index}`
    ) === candidate.taskId);
    if (!task || String(task.status ?? '').toUpperCase() !== 'RUNNING' || task.endTime || task.finishTime) return null;
    return { task, authoritative: true };
  }
  const task = asRecord(candidate.rawTask);
  // 历史详情没有 tasks 时，任务自身的原始快照仍优先于 COALESCE 保留的人员列。
  return { task, authoritative: Object.keys(task).length > 0 };
}

export async function findRunningApprovalTimeoutCandidates(processCodes: string[], corpId: string): Promise<ApprovalTimeoutCandidate[]> {
  if (!processCodes.length) return [];
  return withClient(async (client) => {
    const { rows } = await client.query<{
      corp_id: string;
      process_instance_id: string;
      process_code: string;
      title: string | null;
      task_id: string;
      start_time: Date | null;
      approver_user_id: string | null;
      approver_user_name: string | null;
      node_name: string | null;
      task_raw_payload: unknown;
      instance_raw_payload: unknown;
    }>(
      `SELECT i.corp_id, i.process_instance_id, i.process_code, i.title,
              t.task_id, t.start_time, t.approver_user_id, t.approver_user_name, t.node_name,
              t.raw_payload AS task_raw_payload,
              i.raw_payload AS instance_raw_payload
       FROM ding_approval_instance i
       JOIN ding_approval_task t
         ON t.corp_id = i.corp_id AND t.process_instance_id = i.process_instance_id
       WHERE i.deleted_at IS NULL
         AND UPPER(COALESCE(i.status, '')) = 'RUNNING'
         AND UPPER(COALESCE(t.status, '')) = 'RUNNING'
         AND t.end_time IS NULL
         AND i.process_code = ANY($1::varchar[])
         AND i.corp_id = $2
       ORDER BY i.create_time ASC, t.task_order ASC`,
      [processCodes, corpId]
    );
    return rows.map((row) => ({
      corpId: row.corp_id,
      processInstanceId: row.process_instance_id,
      processCode: row.process_code,
      title: row.title,
      taskId: row.task_id,
      taskStartTime: row.start_time,
      approverUserId: row.approver_user_id,
      approverUserName: row.approver_user_name,
      nodeName: row.node_name,
      rawTask: row.task_raw_payload,
      rawInstance: row.instance_raw_payload,
    }));
  });
}

const defaultDependencies: ApprovalTimeoutMonitorDependencies = {
  now: () => new Date(),
  findCandidates: findRunningApprovalTimeoutCandidates,
  claimDelivery: (key, payload) => claimAlertDelivery(key, payload, REPEAT_MINUTES),
  markSent: markAlertDeliverySent,
  markFailed: markAlertDeliveryFailed,
  send: sendAlertChatMessage,
  sendGroup: sendAlertGroupMessage,
};

export async function monitorApprovalTimeouts(
  dependencies: ApprovalTimeoutMonitorDependencies = defaultDependencies,
): Promise<{ scanned: number; eligible: number; sent: number; failed: number }> {
  const config = getConfig();
  const processCodes = parseList(config.APPROVAL_TIMEOUT_PROCESS_CODES);
  const corpId = config.DINGTALK_CORP_ID?.trim();
  if (!processCodes.length || !corpId) {
    console.log('[ApprovalTimeout] APPROVAL_TIMEOUT_SCOPE_NOT_CONFIGURED');
    return { scanned: 0, eligible: 0, sent: 0, failed: 0 };
  }

  const groups = parseList(config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS);
  const now = dependencies.now();
  const timeoutMinutes = config.APPROVAL_TIMEOUT_MINUTES;
  const timeoutMs = timeoutMinutes * 60_000;
  const candidates = await dependencies.findCandidates(processCodes, corpId);
  const result = { scanned: candidates.length, eligible: 0, sent: 0, failed: 0 };

  for (const candidate of candidates) {
    if (candidate.corpId !== corpId) continue;
    const snapshot = currentTaskSnapshot(candidate);
    if (!snapshot) continue;
    const startedAt = currentNodeStart(candidate);
    if (!startedAt || !Number.isFinite(startedAt.getTime())) {
      console.warn('[ApprovalTimeout] APPROVAL_TIMEOUT_TASK_START_MISSING');
      continue;
    }
    const waitedMs = now.getTime() - startedAt.getTime();
    if (waitedMs < timeoutMs) continue;
    result.eligible++;

    const approvalUrl = `https://applink.dingtalk.com/approval/detail?corpId=${encodeURIComponent(candidate.corpId)}&instanceId=${encodeURIComponent(candidate.processInstanceId)}`;
    const approverUserId = snapshot.authoritative
      ? stringValue(snapshot.task.userId)
      : stringValue(candidate.approverUserId);
    const approverUserName = snapshot.authoritative
      ? (approverUserId ? stringValue(snapshot.task.userName) : null)
      : stringValue(candidate.approverUserName);
    const content = buildApprovalTimeoutMessage({
      title: candidate.title || candidate.processCode,
      nodeName: candidate.nodeName,
      approver: approverUserName || approverUserId,
      waitedMs, timeoutMs, approvalUrl,
    });
    // 固定长度标识兼容 alert_phase VARCHAR(64)，重进同一任务时按实际开始时间区分。
    const taskKey = createHash('sha256').update(JSON.stringify([
      candidate.taskId, startedAt.toISOString(),
    ])).digest('hex').slice(0, 48);
    const targets: Array<{ recipientId: string; channel: string; send: () => Promise<void> }> = [];
    if (approverUserId) {
      targets.push({ recipientId: approverUserId, channel: 'personal', send: () => dependencies.send([approverUserId], content) });
    } else {
      console.warn('[ApprovalTimeout] APPROVAL_TIMEOUT_APPROVER_MISSING');
    }
    for (const group of groups) {
      targets.push({
        recipientId: `group:${createHash('sha256').update(group).digest('hex')}`,
        channel: 'group',
        send: () => dependencies.sendGroup(group, content, approverUserId ? [approverUserId] : []),
      });
    }

    for (const target of targets) {
      const key: AlertDeliveryKey = {
        corpId: candidate.corpId,
        processInstanceId: candidate.processInstanceId,
        alertType: ALERT_TYPE,
        alertPhase: `daily:${taskKey}`,
        recipientUserId: target.recipientId,
      };
      let claimed = false;
      try {
        claimed = await dependencies.claimDelivery(key, {
          processCode: candidate.processCode,
          taskId: candidate.taskId,
          waitedMs,
          startedAt: startedAt.toISOString(),
          channel: target.channel,
          repeatAfterMinutes: REPEAT_MINUTES,
        });
        if (!claimed) continue;
        await target.send();
        await dependencies.markSent(key);
        result.sent++;
      } catch (error) {
        result.failed++;
        const message = error instanceof Error ? error.message : String(error);
        if (claimed) {
          try {
            await dependencies.markFailed(key, message);
          } catch {
            console.error('[ApprovalTimeout] APPROVAL_TIMEOUT_FAILURE_RECORD_FAILED');
          }
        }
        console.error(`[ApprovalTimeout] 发送失败: ${candidate.processInstanceId}`, message);
      }
    }
  }

  console.log(`[ApprovalTimeout] 扫描 ${result.scanned}，已超时 ${result.eligible}，发送 ${result.sent}，失败 ${result.failed}`);
  return result;
}
