/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('ding_alert_notification', {
    id: { type: 'BIGSERIAL', primaryKey: true },
    corp_id: { type: 'VARCHAR(64)', notNull: true },
    process_instance_id: { type: 'VARCHAR(128)', notNull: true },
    alert_type: { type: 'VARCHAR(64)', notNull: true },
    alert_phase: { type: 'VARCHAR(64)', notNull: true },
    recipient_user_id: { type: 'VARCHAR(128)', notNull: true },
    status: { type: 'VARCHAR(32)', notNull: true, default: 'sending' },
    attempt_count: { type: 'INTEGER', notNull: true, default: 0 },
    payload: { type: 'JSONB' },
    last_error: { type: 'TEXT' },
    sent_at: { type: 'TIMESTAMPTZ' },
    created_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('ding_alert_notification', 'ding_alert_notification_unique_delivery', {
    unique: ['corp_id', 'process_instance_id', 'alert_type', 'alert_phase', 'recipient_user_id'],
  });
  pgm.createIndex('ding_alert_notification', ['status', 'updated_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('ding_alert_notification');
};
