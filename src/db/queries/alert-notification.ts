import { withClient } from '../pool.js';

export interface AlertDeliveryKey {
  corpId: string;
  processInstanceId: string;
  alertType: string;
  alertPhase: string;
  recipientUserId: string;
}

export async function claimAlertDelivery(key: AlertDeliveryKey, payload: Record<string, unknown>): Promise<boolean> {
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
       WHERE ding_alert_notification.status = 'failed'
          OR (ding_alert_notification.status = 'sending'
              AND ding_alert_notification.updated_at < now() - interval '15 minutes')`,
      [
        key.corpId,
        key.processInstanceId,
        key.alertType,
        key.alertPhase,
        key.recipientUserId,
        JSON.stringify(payload),
      ]
    );
    return rowCount === 1;
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
