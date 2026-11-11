import { withClient } from '../pool.js';

export interface AlertDeliveryKey {
  corpId: string;
  processInstanceId: string;
  alertType: string;
  alertPhase: string;
  recipientUserId: string;
}

export type AlertDeliveryTarget = Pick<AlertDeliveryKey, 'corpId' | 'alertType' | 'recipientUserId'>;
type AlertDeliveryItemKey = Pick<AlertDeliveryKey, 'processInstanceId' | 'alertPhase'>;
export type AlertDeliveryClaim = AlertDeliveryItemKey & { payload: Record<string, unknown> };
export type ClaimedAlertDelivery = AlertDeliveryItemKey & { attemptCount: number };

function canClaim(repeatMinutesParam: string): string {
  return `ding_alert_notification.status = 'failed'
    OR (ding_alert_notification.status = 'sending'
        AND ding_alert_notification.updated_at < now() - interval '15 minutes')
    OR (ding_alert_notification.status = 'sent'
        AND ${repeatMinutesParam}::integer IS NOT NULL
        AND ding_alert_notification.sent_at <= now() - make_interval(mins => ${repeatMinutesParam}::integer))`;
}

function validateRepeatInterval(repeatAfterMinutes?: number): void {
  if (repeatAfterMinutes !== undefined && (!Number.isSafeInteger(repeatAfterMinutes) || repeatAfterMinutes <= 0)) {
    throw new Error('ALERT_INVALID_REPEAT_INTERVAL');
  }
}

export async function claimAlertDelivery(
  key: AlertDeliveryKey,
  payload: Record<string, unknown>,
  repeatAfterMinutes?: number,
): Promise<boolean> {
  validateRepeatInterval(repeatAfterMinutes);
  return withClient(async (client) => {
    const { rowCount } = await client.query(
      `INSERT INTO ding_alert_notification (
         corp_id, process_instance_id, alert_type, alert_phase, recipient_user_id,
         status, attempt_count, payload, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'sending', 1, $6, now())
       ON CONFLICT (corp_id, process_instance_id, alert_type, alert_phase, recipient_user_id)
       DO UPDATE SET
         status = 'sending',
         attempt_count = ding_alert_notification.attempt_count + 1,
         payload = EXCLUDED.payload,
         last_error = NULL,
         updated_at = now()
       WHERE ${canClaim('$7')}`,
      [
        key.corpId,
        key.processInstanceId,
        key.alertType,
        key.alertPhase,
        key.recipientUserId,
        JSON.stringify(payload),
        repeatAfterMinutes ?? null,
      ]
    );
    return rowCount === 1;
  });
}

/** 一次领取同一目标的到期任务。排序使并行扫描按同一顺序竞争投递记录。 */
export async function claimAlertDeliveryBatch(
  target: AlertDeliveryTarget,
  items: AlertDeliveryClaim[],
  repeatAfterMinutes: number,
): Promise<ClaimedAlertDelivery[]> {
  validateRepeatInterval(repeatAfterMinutes);
  if (!items.length) return [];
  return withClient(async client => (await client.query<ClaimedAlertDelivery>(
    `INSERT INTO ding_alert_notification (
       corp_id, process_instance_id, alert_type, alert_phase, recipient_user_id,
       status, attempt_count, payload, updated_at
     )
     SELECT $1, item."processInstanceId", $2, item."alertPhase", $3, 'sending', 1, item.payload, clock_timestamp()
     FROM jsonb_to_recordset($4::jsonb) AS item("processInstanceId" text, "alertPhase" text, payload jsonb)
     ORDER BY item."processInstanceId", item."alertPhase"
     ON CONFLICT (corp_id, process_instance_id, alert_type, alert_phase, recipient_user_id)
     DO UPDATE SET status = 'sending', attempt_count = ding_alert_notification.attempt_count + 1,
       payload = EXCLUDED.payload, last_error = NULL, updated_at = clock_timestamp()
     WHERE ${canClaim('$5')}
     RETURNING process_instance_id AS "processInstanceId", alert_phase AS "alertPhase", attempt_count AS "attemptCount"`,
    [target.corpId, target.alertType, target.recipientUserId, JSON.stringify(items), repeatAfterMinutes],
  )).rows);
}

/** 发消息前续租当前分段，旧尝试和已经过期的领取均不再发送。 */
export async function renewAlertDeliveryBatch(
  target: AlertDeliveryTarget,
  claims: ClaimedAlertDelivery[],
): Promise<ClaimedAlertDelivery[]> {
  if (!claims.length) return [];
  return withClient(async client => (await client.query<ClaimedAlertDelivery>(
    `WITH owned AS MATERIALIZED (
       SELECT n.id FROM ding_alert_notification n
       JOIN jsonb_to_recordset($4::jsonb) AS item("processInstanceId" text, "alertPhase" text, "attemptCount" int)
         ON n.process_instance_id = item."processInstanceId" AND n.alert_phase = item."alertPhase"
       WHERE n.corp_id = $1 AND n.alert_type = $2 AND n.recipient_user_id = $3
         AND n.status = 'sending' AND n.attempt_count = item."attemptCount"
       FOR NO KEY UPDATE OF n SKIP LOCKED
     )
     UPDATE ding_alert_notification n SET updated_at = clock_timestamp()
     FROM owned WHERE n.id = owned.id AND n.updated_at >= clock_timestamp() - interval '15 minutes'
     RETURNING n.process_instance_id AS "processInstanceId", n.alert_phase AS "alertPhase", n.attempt_count AS "attemptCount"`,
    [target.corpId, target.alertType, target.recipientUserId, JSON.stringify(claims)],
  )).rows);
}

/** 同一条汇总消息的任务共享投递结果。已被重新领取的任务由新尝试写入。 */
export async function finishAlertDeliveryBatch(
  target: AlertDeliveryTarget,
  claims: ClaimedAlertDelivery[],
  batchId: string | null,
  error?: string,
): Promise<void> {
  if (!claims.length) return;
  await withClient(async client => {
    await client.query(
      `UPDATE ding_alert_notification n
       SET status = $6::varchar, sent_at = CASE WHEN $6::varchar = 'sent' THEN now() ELSE n.sent_at END,
           last_error = $7, updated_at = now(),
           payload = CASE WHEN $5::text IS NULL THEN n.payload ELSE n.payload || jsonb_build_object('batchId', $5::text) END
       FROM jsonb_to_recordset($4::jsonb) AS item("processInstanceId" text, "alertPhase" text, "attemptCount" int)
       WHERE n.corp_id = $1 AND n.alert_type = $2 AND n.recipient_user_id = $3
         AND n.process_instance_id = item."processInstanceId" AND n.alert_phase = item."alertPhase"
         AND n.status = 'sending' AND n.attempt_count = item."attemptCount"`,
      [target.corpId, target.alertType, target.recipientUserId, JSON.stringify(claims), batchId,
        error === undefined ? 'sent' : 'failed', error?.slice(0, 2000) ?? null],
    );
  });
}

export async function markAlertDeliverySent(key: AlertDeliveryKey): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE ding_alert_notification
       SET status = 'sent', sent_at = now(), last_error = NULL, updated_at = now()
       WHERE corp_id = $1 AND process_instance_id = $2 AND alert_type = $3
         AND alert_phase = $4 AND recipient_user_id = $5`,
      [key.corpId, key.processInstanceId, key.alertType, key.alertPhase, key.recipientUserId]
    );
  });
}

export async function markAlertDeliveryFailed(key: AlertDeliveryKey, error: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE ding_alert_notification
       SET status = 'failed', last_error = $6, updated_at = now()
       WHERE corp_id = $1 AND process_instance_id = $2 AND alert_type = $3
         AND alert_phase = $4 AND recipient_user_id = $5`,
      [key.corpId, key.processInstanceId, key.alertType, key.alertPhase, key.recipientUserId, error.slice(0, 2000)]
    );
  });
}
