/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('ding_event_log', {
    id: { type: 'BIGSERIAL', primaryKey: true },
    corp_id: { type: 'VARCHAR(64)', notNull: true },
    event_id: { type: 'VARCHAR(128)' },
    event_type: { type: 'VARCHAR(64)', notNull: true },
    source: { type: 'VARCHAR(32)', notNull: true },
    process_instance_id: { type: 'VARCHAR(128)' },
    process_code: { type: 'VARCHAR(128)' },
    received_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
    processed_at: { type: 'TIMESTAMPTZ' },
    duration_ms: { type: 'INTEGER' },
    status: { type: 'VARCHAR(32)', notNull: true, default: 'pending' },
    retry_count: { type: 'INTEGER', notNull: true, default: 0 },
    error_message: { type: 'TEXT' },
    raw_event: { type: 'JSONB' },
  });

  // 部分唯一索引：event_id 存在时才生效
  pgm.createIndex('ding_event_log', ['corp_id', 'event_id'], {
    name: 'idx_event_log_corp_event_unique',
    unique: true,
    where: 'event_id IS NOT NULL',
  });

  pgm.createIndex('ding_event_log', ['status']);
  pgm.createIndex('ding_event_log', ['process_instance_id']);
  pgm.createIndex('ding_event_log', ['received_at']);
  pgm.createIndex('ding_event_log', ['corp_id', 'event_type']);
};

exports.down = (pgm) => {
  pgm.dropTable('ding_event_log');
};
