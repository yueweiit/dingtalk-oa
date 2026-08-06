/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('ding_event_outbox', {
    id: { type: 'BIGSERIAL', primaryKey: true },
    corp_id: { type: 'VARCHAR(64)', notNull: true },
    event_id: { type: 'VARCHAR(128)', notNull: true },
    event_key: { type: 'VARCHAR(256)', notNull: true },
    topic: { type: 'VARCHAR(256)', notNull: true },
    event_type: { type: 'VARCHAR(64)', notNull: true },
    source: { type: 'VARCHAR(32)', notNull: true },
    process_instance_id: { type: 'VARCHAR(128)' },
    process_code: { type: 'VARCHAR(128)' },
    payload: { type: 'JSONB', notNull: true },
    status: { type: 'VARCHAR(32)', notNull: true, default: 'pending' },
    attempt_count: { type: 'INTEGER', notNull: true, default: 0 },
    next_attempt_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
    last_error: { type: 'TEXT' },
    published_at: { type: 'TIMESTAMPTZ' },
    created_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('ding_event_outbox', 'ding_event_outbox_corp_event_unique', {
    unique: ['corp_id', 'event_id'],
  });
  pgm.createIndex('ding_event_outbox', ['status', 'next_attempt_at'], {
    name: 'idx_event_outbox_pending',
  });
  pgm.createIndex('ding_event_outbox', ['created_at'], {
    name: 'idx_event_outbox_created_at',
  });

  pgm.sql(`COMMENT ON TABLE ding_event_outbox IS '审批事件发送队列 - 先持久化事件，再异步投递 Kafka，保证 Kafka 故障期间事件可恢复'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.id IS '主键ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.corp_id IS '钉钉企业ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.event_id IS '事件唯一ID，用于幂等去重'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.event_key IS 'Kafka 消息键'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.topic IS '目标 Kafka topic'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.event_type IS '审批事件类型'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.source IS '事件来源，如 stream 或 webhook'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.process_instance_id IS '审批实例ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.process_code IS '审批流程编码'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.payload IS '待发送的完整事件消息'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.status IS '发送状态：pending、publishing 或 published'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.attempt_count IS '已尝试发送次数'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.next_attempt_at IS '下一次允许发送时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.last_error IS '最近一次发送失败原因'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.published_at IS '成功发送时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.created_at IS '记录创建时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_outbox.updated_at IS '记录最后更新时间'`);
};

exports.down = (pgm) => {
  pgm.dropTable('ding_event_outbox');
};
