import { getConfig } from '../config/index.js';
import { withClient } from '../db/pool.js';
import {
  claimAlertDelivery,
  markAlertDeliveryFailed,
  markAlertDeliverySent,
  type AlertDeliveryKey,
} from '../db/queries/alert-notification.js';
import { sendAlertChatMessage } from '../dingtalk/alert-robot.js';
import { parseDingTalkTime } from '../normalize/instance-normalizer.js';

const ALERT_TYPE = 'approval_timeout';

export interface ApprovalTimeoutCandidate {
  corpId: string;
  processInstanceId: string;
  processCode: string;
  title: string | null;
  taskId: string;
  taskStartTime: Date | null;
  rawTask: unknown;
  rawInstance: unknown;
}

export interface ApprovalTimeoutMonitorDependencies {
  now: () => Date;
  findCandidates: (processCodes: string[]) => Promise<ApprovalTimeoutCandidate[]>;
  claimDelivery: (key: AlertDeliveryKey, payload: Record<string, unknown>) => Promise<boolean>;
  markSent: (key: AlertDeliveryKey) => Promise<void>;
  markFailed: (key: AlertDeliveryKey, error: string) => Promise<void>;
  send: (userIds: string[], content: string) => Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function currentNodeStart(candidate: ApprovalTimeoutCandidate): Date | null {
  if (candidate.taskStartTime) return candidate.taskStartTime;
  const task = asRecord(candidate.rawTask);
  const taskDate = parseDingTalkTime(task.createTime ?? task.startTime);
  if (taskDate) return taskDate;

  const instance = asRecord(candidate.rawInstance);
  const records = Array.isArray(instance.operationRecords) ? instance.operationRecords : [];
  let newest: Date | null = null;
  for (const record of records) {
    const item = asRecord(record);
    const date = parseDingTalkTime(item.date ?? item.createTime);
    if (date && (!newest || date > newest)) newest = date;
  }
  return newest ?? parseDingTalkTime(instance.createTime);
}

function formatWait(durationMs: number): string {
  const minutes = Math.max(0, Math.floor(durationMs / 60_000));
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分钟`;
}

function recipientsFromConfig(): string[] {
  return [...new Set(getConfig().DINGTALK_ALERT_RECIPIENT_USER_IDS
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean))];
}

function processCodesFromConfig(): string[] {
  return [...new Set(getConfig().APPROVAL_TIMEOUT_PROCESS_CODES
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean))];
}

export async function findRunningApprovalTimeoutCandidates(processCodes: string[]): Promise<ApprovalTimeoutCandidate[]> {
  if (!processCodes.length) return [];
  return withClient(async (client) => {
    const { rows } = await client.query<{
      corp_id: string;
      process_instance_id: string;
      process_code: string;
      title: string | null;
      task_id: string;
      start_time: Date | null;
      task_raw_payload: unknown;
      instance_raw_payload: unknown;
    }>(
      `SELECT i.corp_id, i.process_instance_id, i.process_code, i.title,
              t.task_id, t.start_time, t.raw_payload AS task_raw_payload,
              i.raw_payload AS instance_raw_payload
       FROM ding_approval_instance i
       JOIN ding_approval_task t
         ON t.corp_id = i.corp_id AND t.process_instance_id = i.process_instance_id
       WHERE i.deleted_at IS NULL
         AND UPPER(COALESCE(i.status, '')) = 'RUNNING'
         AND UPPER(COALESCE(t.status, '')) = 'RUNNING'
         AND i.process_code = ANY($1::varchar[])
       ORDER BY i.create_time ASC, t.task_order ASC`,
      [processCodes]
    );
    return rows.map((row) => ({
      corpId: row.corp_id,
      processInstanceId: row.process_instance_id,
      processCode: row.process_code,
      title: row.title,
      taskId: row.task_id,
      taskStartTime: row.start_time,
      rawTask: row.task_raw_payload,
      rawInstance: row.instance_raw_payload,
    }));
  });
}

const defaultDependencies: ApprovalTimeoutMonitorDependencies = {
  now: () => new Date(),
  findCandidates: findRunningApprovalTimeoutCandidates,
  claimDelivery: claimAlertDelivery,
  markSent: markAlertDeliverySent,
  markFailed: markAlertDeliveryFailed,
  send: sendAlertChatMessage,
};

export async function monitorApprovalTimeouts(
  dependencies: ApprovalTimeoutMonitorDependencies = defaultDependencies,
): Promise<{ scanned: number; eligible: number; sent: number; failed: number }> {
  const processCodes = processCodesFromConfig();
  const recipients = recipientsFromConfig();
  if (!processCodes.length || !recipients.length) {
    console.log('[ApprovalTimeout] 未配置流程码或接收人，跳过检查');
    return { scanned: 0, eligible: 0, sent: 0, failed: 0 };
  }

  const config = getConfig();
  const now = dependencies.now();
  const beforeMinutes = config.APPROVAL_TIMEOUT_WINDOW_BEFORE_MINUTES;
  const afterMinutes = config.APPROVAL_TIMEOUT_WINDOW_AFTER_MINUTES;
  const timeoutMinutes = config.APPROVAL_TIMEOUT_MINUTES;
  const lowerBoundMs = (timeoutMinutes - beforeMinutes) * 60_000;
  const upperBoundMs = (timeoutMinutes + afterMinutes) * 60_000;
  const timeoutMs = timeoutMinutes * 60_000;
  const candidates = await dependencies.findCandidates(processCodes);
  const result = { scanned: candidates.length, eligible: 0, sent: 0, failed: 0 };

  for (const candidate of candidates) {
    const startedAt = currentNodeStart(candidate);
    if (!startedAt) continue;
    const waitedMs = now.getTime() - startedAt.getTime();
    if (waitedMs < lowerBoundMs || waitedMs > upperBoundMs) continue;
    result.eligible++;

    const phase = waitedMs < timeoutMs ? 'before' : 'after';
    const phaseLabel = phase === 'before' ? '即将超时' : '已超时';
    const approvalUrl = `https://applink.dingtalk.com/approval/detail?corpId=${encodeURIComponent(candidate.corpId)}&instanceId=${encodeURIComponent(candidate.processInstanceId)}`;
    const content = [
      `【审批${phaseLabel}】`,
      `流程：${candidate.title || candidate.processCode}`,
      `已等待：${formatWait(waitedMs)}（时限 ${formatWait(timeoutMs)}）`,
      `审批单：${approvalUrl}`,
    ].join('\n');

    for (const recipientUserId of recipients) {
      const key: AlertDeliveryKey = {
        corpId: candidate.corpId,
        processInstanceId: candidate.processInstanceId,
        alertType: ALERT_TYPE,
        alertPhase: `${phase}:${candidate.taskId}`,
        recipientUserId,
      };
      const claimed = await dependencies.claimDelivery(key, {
        processCode: candidate.processCode,
        taskId: candidate.taskId,
        waitedMs,
        phase,
      });
      if (!claimed) continue;
      try {
        await dependencies.send([recipientUserId], content);
        await dependencies.markSent(key);
        result.sent++;
      } catch (error) {
        result.failed++;
        const message = error instanceof Error ? error.message : String(error);
        await dependencies.markFailed(key, message);
        console.error(`[ApprovalTimeout] 发送失败: ${candidate.processInstanceId}`, message);
      }
    }
  }

  console.log(`[ApprovalTimeout] 扫描 ${result.scanned}，窗口内 ${result.eligible}，发送 ${result.sent}，失败 ${result.failed}`);
  return result;
}
