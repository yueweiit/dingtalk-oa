import { createHash, randomUUID } from 'node:crypto';
import { getConfig } from '../config/index.js';
import { withClient } from '../db/pool.js';
import {
  claimAlertDeliveryBatch,
  finishAlertDeliveryBatch,
  renewAlertDeliveryBatch,
  type AlertDeliveryClaim,
  type AlertDeliveryTarget,
  type ClaimedAlertDelivery,
} from '../db/queries/alert-notification.js';
import { findCurrentSnapshotNames } from '../db/queries/user-snapshot.js';
import { sendAlertChatMessage, sendAlertGroupMessage } from '../dingtalk/alert-robot.js';
import { parseDingTalkTime } from '../normalize/instance-normalizer.js';
import { buildApprovalTimeoutMessages, type ApprovalTimeoutLocale, type ApprovalTimeoutMessageItem } from './approval-timeout-message.js';

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
  nodeName: string | null;
  rawTask: unknown;
  rawInstance: unknown;
}

export interface ApprovalTimeoutMonitorDependencies {
  now: () => Date;
  findCandidates: typeof findRunningApprovalTimeoutCandidates;
  findApproverProfiles: typeof findCurrentSnapshotNames;
  claimDeliveries: (target: AlertDeliveryTarget, items: AlertDeliveryClaim[]) => Promise<ClaimedAlertDelivery[]>;
  renewDeliveries: typeof renewAlertDeliveryBatch;
  finishDeliveries: typeof finishAlertDeliveryBatch;
  send: (userIds: string[], content: string, title: string) => Promise<void>;
  sendGroup: (conversationId: string, content: string, mentionUserIds: string[], title: string) => Promise<void>;
}

type TaskRef = Pick<ApprovalTimeoutCandidate, 'processInstanceId' | 'taskId'>;
type PendingDelivery = ApprovalTimeoutMessageItem & { ref: TaskRef; delivery: AlertDeliveryClaim };
type ClaimedTimeoutDelivery = PendingDelivery & { claim: ClaimedAlertDelivery };
type TimeoutMessage = ReturnType<typeof buildApprovalTimeoutMessages<ClaimedTimeoutDelivery>>[number];

interface DeliveryGroup {
  target: AlertDeliveryTarget;
  channel: 'personal' | 'group';
  address: string;
  items: PendingDelivery[];
}

function deliveryItemKey(item: Pick<AlertDeliveryClaim, 'processInstanceId' | 'alertPhase'>): string {
  return JSON.stringify([item.processInstanceId, item.alertPhase]);
}

function taskRefKey(task: TaskRef): string {
  return JSON.stringify([task.processInstanceId, task.taskId]);
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

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

function displayName(value: unknown, userId: string): string | null {
  const name = stringValue(value);
  return name && name !== userId && name.toLowerCase() !== 'unknown' ? name : null;
}

function taskNameForAccount(task: Record<string, unknown>, userId: string): string | null {
  return stringValue(task.userId) === userId ? displayName(task.userName, userId) : null;
}

function localeFromSnapshotName(name: string | null): ApprovalTimeoutLocale {
  // 逐层移除配对括号里的别名，保留括号外的全部姓名。
  let mainName = name ?? '';
  let previous: string;
  do {
    previous = mainName;
    mainName = mainName.replace(/[（(][^（）()]*[）)]/gu, '');
  } while (mainName !== previous);
  const letters = mainName.match(/\p{L}/gu);
  return letters?.length && letters.every(letter => /\p{Script=Latin}/u.test(letter)) ? 'es' : 'zh-CN';
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

export async function findRunningApprovalTimeoutCandidates(
  processCodes: string[], corpId: string, refs?: TaskRef[],
): Promise<ApprovalTimeoutCandidate[]> {
  if (!processCodes.length || refs?.length === 0) return [];
  return withClient(async (client) => {
    const { rows } = await client.query<{
      corp_id: string;
      process_instance_id: string;
      process_code: string;
      title: string | null;
      task_id: string;
      start_time: Date | null;
      approver_user_id: string | null;
      node_name: string | null;
      task_raw_payload: unknown;
      instance_raw_payload: unknown;
    }>(
      `SELECT i.corp_id, i.process_instance_id, i.process_code, i.title,
              t.task_id, t.start_time, t.approver_user_id, t.node_name,
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
         ${refs ? `AND EXISTS (SELECT 1
           FROM jsonb_to_recordset($3::jsonb) AS ref("processInstanceId" text, "taskId" text)
           WHERE ref."processInstanceId" = i.process_instance_id AND ref."taskId" = t.task_id)` : ''}
       ORDER BY i.create_time ASC, t.task_order ASC`,
      refs ? [processCodes, corpId, JSON.stringify(refs)] : [processCodes, corpId]
    );
    return rows.map((row) => ({
      corpId: row.corp_id,
      processInstanceId: row.process_instance_id,
      processCode: row.process_code,
      title: row.title,
      taskId: row.task_id,
      taskStartTime: row.start_time,
      approverUserId: row.approver_user_id,
      nodeName: row.node_name,
      rawTask: row.task_raw_payload,
      rawInstance: row.instance_raw_payload,
    }));
  });
}

const defaultDependencies: ApprovalTimeoutMonitorDependencies = {
  now: () => new Date(),
  findCandidates: findRunningApprovalTimeoutCandidates,
  findApproverProfiles: findCurrentSnapshotNames,
  claimDeliveries: (target, items) => claimAlertDeliveryBatch(target, items, REPEAT_MINUTES),
  renewDeliveries: renewAlertDeliveryBatch,
  finishDeliveries: finishAlertDeliveryBatch,
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

  const groups = parseList(config.APPROVAL_TIMEOUT_GROUP_CONVERSATION_IDS).map(address => ({
    address,
    recipientUserId: `group:${createHash('sha256').update(address).digest('hex')}`,
  }));
  const spanishUserIds = new Set(parseList(config.APPROVAL_TIMEOUT_ES_USER_IDS));
  const chineseUserIds = new Set(parseList(config.APPROVAL_TIMEOUT_ZH_USER_IDS));
  const snapshotNames = new Map<string, string | null>();
  const processScope = new Set(processCodes);
  const pausedInstances = new Set(config.APPROVAL_TIMEOUT_PAUSED_INSTANCES
    .filter(([enterprise]) => enterprise === corpId)
    .map(([, instanceId]) => instanceId));
  const now = dependencies.now();
  const timeoutMinutes = config.APPROVAL_TIMEOUT_MINUTES;
  const timeoutMs = timeoutMinutes * 60_000;
  const candidates = await dependencies.findCandidates(processCodes, corpId);
  const result = { scanned: candidates.length, eligible: 0, sent: 0, failed: 0 };
  const deliveryGroups = new Map<string, DeliveryGroup>();
  const redirectedGroups = new Map<string, DeliveryGroup>();
  const queue = (
    queueGroups: Map<string, DeliveryGroup>, channel: DeliveryGroup['channel'],
    address: string, recipientUserId: string, item: PendingDelivery,
  ) => {
    const groupKey = `${channel}:${address}`;
    let group = queueGroups.get(groupKey);
    if (!group) {
      group = { target: { corpId, alertType: ALERT_TYPE, recipientUserId }, channel, address, items: [] };
      queueGroups.set(groupKey, group);
    }
    group.items.push(item);
  };

  const resolve = (candidate: ApprovalTimeoutCandidate): PendingDelivery | null => {
    if (candidate.corpId !== corpId || !processScope.has(candidate.processCode)) return null;
    if (pausedInstances.has(candidate.processInstanceId)) return null;
    const snapshot = currentTaskSnapshot(candidate);
    if (!snapshot) return null;
    const startedAt = currentNodeStart(candidate);
    if (!startedAt || !Number.isFinite(startedAt.getTime())) {
      console.warn('[ApprovalTimeout] APPROVAL_TIMEOUT_TASK_START_MISSING');
      return null;
    }
    const waitedMs = now.getTime() - startedAt.getTime();
    if (waitedMs < timeoutMs) return null;

    const approvalUrl = new URL('https://applink.dingtalk.com/approval/detail');
    approvalUrl.searchParams.set('corpId', candidate.corpId);
    approvalUrl.searchParams.set('instanceId', candidate.processInstanceId);
    const approverUserId = snapshot.authoritative
      ? stringValue(snapshot.task.userId)
      : stringValue(candidate.approverUserId);
    // 历史归档姓名可能属于转交前的账号，原始任务须用同一份数据证明 ID 和姓名的关联。
    const approverUserName = approverUserId
      ? taskNameForAccount(snapshot.task, approverUserId)
        ?? taskNameForAccount(asRecord(candidate.rawTask), approverUserId)
      : null;
    // 固定长度标识兼容 alert_phase VARCHAR(64)，重进同一任务时按实际开始时间区分。
    const taskKey = createHash('sha256').update(JSON.stringify([
      candidate.taskId, startedAt.toISOString(),
    ])).digest('hex').slice(0, 48);
    return {
      ref: { processInstanceId: candidate.processInstanceId, taskId: candidate.taskId },
      title: candidate.title || candidate.processCode,
      nodeName: candidate.nodeName,
      approver: approverUserName,
      approverUserId,
      locale: 'zh-CN',
      waitedMs,
      approvalUrl: approvalUrl.href,
      delivery: {
        processInstanceId: candidate.processInstanceId,
        alertPhase: `daily:${taskKey}`,
        payload: {
          processCode: candidate.processCode,
          taskId: candidate.taskId,
          waitedMs,
          startedAt: startedAt.toISOString(),
          repeatAfterMinutes: REPEAT_MINUTES,
        },
      },
    };
  };

  const resolveItems = async (rows: ApprovalTimeoutCandidate[]) => {
    const items = rows.flatMap(row => {
      const item = resolve(row);
      return item ? [item] : [];
    });
    const missingIds = [...new Set(items.flatMap(({ approverUserId }) =>
      approverUserId && !snapshotNames.has(approverUserId) ? [approverUserId] : []))];
    if (missingIds.length) {
      try {
        const profiles = await dependencies.findApproverProfiles(corpId, missingIds);
        const names = new Map(profiles.map(profile => [profile.userId, displayName(profile.name, profile.userId)]));
        for (const id of missingIds) snapshotNames.set(id, names.get(id) ?? null);
      } catch (error) {
        console.warn('[ApprovalTimeout] APPROVAL_TIMEOUT_APPROVER_NAME_LOOKUP_FAILED', errorMessage(error));
      }
    }
    for (const item of items) {
      const id = item.approverUserId;
      if (!id) continue;
      const name = snapshotNames.get(id) ?? null;
      item.approver = name ?? item.approver;
      if (chineseUserIds.has(id)) item.locale = 'zh-CN';
      else if (spanishUserIds.has(id)) item.locale = 'es';
      else item.locale = localeFromSnapshotName(name);
    }
    return items;
  };

  for (const item of await resolveItems(candidates)) {
    result.eligible++;
    if (item.approverUserId) {
      queue(deliveryGroups, 'personal', item.approverUserId, item.approverUserId, item);
    } else {
      console.warn('[ApprovalTimeout] APPROVAL_TIMEOUT_APPROVER_MISSING');
    }
    for (const group of groups) queue(deliveryGroups, 'group', group.address, group.recipientUserId, item);
  }

  const finish = async (target: AlertDeliveryTarget, claims: ClaimedAlertDelivery[], batchId: string | null, failure?: string) => {
    if (!claims.length) return;
    try {
      await dependencies.finishDeliveries(target, claims, batchId, failure);
    } catch (error) {
      result.failed++;
      console.error(`[ApprovalTimeout] APPROVAL_TIMEOUT_BATCH_RESULT_FAILED ${batchId ?? 'unsent'}`, errorMessage(error));
    }
  };

  const refreshPart = async (group: DeliveryGroup, items: ClaimedTimeoutDelivery[], allowReroute: boolean) => {
    const rows = await dependencies.findCandidates(processCodes, corpId, items.map(item => item.ref));
    const currentByTask = new Map((await resolveItems(rows)).map(item => [taskRefKey(item.ref), item]));
    const refreshed: ClaimedTimeoutDelivery[] = [];
    const obsolete: ClaimedAlertDelivery[] = [];
    for (const item of items) {
      const current = currentByTask.get(taskRefKey(item.ref));
      const address = group.channel === 'group' ? group.address : current?.approverUserId;
      if (current && address === group.address && current.delivery.alertPhase === item.claim.alertPhase) {
        refreshed.push({ ...current, claim: item.claim });
        continue;
      }
      obsolete.push(item.claim);
      if (allowReroute && current && address) {
        const key = `${group.channel}:${address}`;
        const queueGroups = deliveryGroups.has(key) ? deliveryGroups : redirectedGroups;
        const recipientUserId = group.channel === 'group' ? group.target.recipientUserId : address;
        queue(queueGroups, group.channel, address, recipientUserId, current);
      }
    }
    await finish(group.target, obsolete, null, 'APPROVAL_TIMEOUT_TASK_CHANGED');
    return refreshed;
  };

  const deliver = async (group: DeliveryGroup, allowReroute: boolean) => {
    let claims: ClaimedAlertDelivery[];
    try {
      claims = await dependencies.claimDeliveries(group.target, group.items.map(({ delivery }) => ({
        ...delivery, payload: { ...delivery.payload, channel: group.channel },
      })));
    } catch (error) {
      result.failed++;
      console.error('[ApprovalTimeout] APPROVAL_TIMEOUT_BATCH_CLAIM_FAILED', errorMessage(error));
      return;
    }
    if (!claims.length) return;
    const claimedByKey = new Map(claims.map(claim => [deliveryItemKey(claim), claim]));
    const claimedItems = group.items.flatMap(item => {
      const claim = claimedByKey.get(deliveryItemKey(item.delivery));
      return claim ? [{ ...item, claim }] : [];
    });
    let parts: ClaimedTimeoutDelivery[][];
    try {
      parts = buildApprovalTimeoutMessages(claimedItems, group.channel === 'group').map(message => message.items);
    } catch (error) {
      result.failed++;
      console.error('[ApprovalTimeout] APPROVAL_TIMEOUT_BATCH_FORMAT_FAILED', errorMessage(error));
      await finish(group.target, claims, null, errorMessage(error));
      return;
    }

    for (let index = 0; index < parts.length; index++) {
      const planned = parts[index];
      let preparingClaims = planned.map(item => item.claim);
      let message: TimeoutMessage | undefined;
      try {
        const refreshed = await refreshPart(group, planned, allowReroute);
        const [current, ...extra] = buildApprovalTimeoutMessages(refreshed, group.channel === 'group');
        if (!current) continue;
        // 刷新后正文可能变长，新增分段也须在实际发送前复核。
        parts.splice(index + 1, 0, ...extra.map(part => part.items));
        preparingClaims = current.items.map(item => item.claim);
        const active = await dependencies.renewDeliveries(group.target, preparingClaims);
        const activeKeys = new Set(active.map(deliveryItemKey));
        const activeItems = current.items.filter(item => activeKeys.has(deliveryItemKey(item.claim)));
        // 删除失效条目只会缩短本段，同时移除对应群 @。
        [message] = buildApprovalTimeoutMessages(activeItems, group.channel === 'group');
      } catch (error) {
        result.failed++;
        console.error('[ApprovalTimeout] APPROVAL_TIMEOUT_BATCH_PREPARE_FAILED', errorMessage(error));
        await finish(group.target, preparingClaims, null, errorMessage(error));
        continue;
      }
      if (!message) continue;
      const batchId = randomUUID();
      let failure: string | undefined;
      try {
        if (group.channel === 'group') {
          await dependencies.sendGroup(group.address, message.content, message.mentionUserIds, message.title);
        } else {
          await dependencies.send([group.address], message.content, message.title);
        }
        result.sent++;
      } catch (error) {
        result.failed++;
        failure = errorMessage(error);
        console.error(`[ApprovalTimeout] APPROVAL_TIMEOUT_BATCH_SEND_FAILED ${batchId}`, failure);
      }
      await finish(group.target, message.items.map(item => item.claim), batchId, failure);
    }
  };

  for (const [key, group] of deliveryGroups) {
    deliveryGroups.delete(key);
    await deliver(group, true);
  }
  // 已处理目标的转交补充本轮发送。若此时再次变化，留到下一轮扫描。
  for (const group of redirectedGroups.values()) await deliver(group, false);

  console.log(`[ApprovalTimeout] 扫描 ${result.scanned}，已超时 ${result.eligible}，汇总消息发送 ${result.sent}，失败 ${result.failed}`);
  return result;
}
