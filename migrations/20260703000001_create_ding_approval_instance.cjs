/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('ding_approval_instance', {
    id: { type: 'BIGSERIAL', primaryKey: true },
    corp_id: { type: 'VARCHAR(64)', notNull: true },
    process_instance_id: { type: 'VARCHAR(128)', notNull: true },
    process_code: { type: 'VARCHAR(128)', notNull: true },
    title: { type: 'VARCHAR(500)' },
    status: { type: 'VARCHAR(32)' },
    result: { type: 'VARCHAR(32)' },
    originator_user_id: { type: 'VARCHAR(128)' },
    originator_user_name: { type: 'VARCHAR(256)' },
    originator_dept_id: { type: 'VARCHAR(128)' },
    originator_dept_name: { type: 'VARCHAR(256)' },
    create_time: { type: 'TIMESTAMPTZ' },
    finish_time: { type: 'TIMESTAMPTZ' },
    form_component_values: { type: 'JSONB' },
    raw_payload: { type: 'JSONB' },
    last_event_time: { type: 'TIMESTAMPTZ' },
    deleted_at: { type: 'TIMESTAMPTZ' },
    updated_at: { type: 'TIMESTAMPTZ', default: pgm.func('now()') },
    created_at: { type: 'TIMESTAMPTZ', default: pgm.func('now()') },
  });

  pgm.addConstraint('ding_approval_instance', 'ding_approval_instance_corp_process_unique', {
    unique: ['corp_id', 'process_instance_id'],
  });

  pgm.createIndex('ding_approval_instance', ['process_code']);
  pgm.createIndex('ding_approval_instance', ['originator_user_id']);
  pgm.createIndex('ding_approval_instance', ['create_time']);
  pgm.createIndex('ding_approval_instance', ['status']);
  pgm.createIndex('ding_approval_instance', ['corp_id', 'status']);

  // GIN 索引 on form_component_values
  pgm.createIndex('ding_approval_instance', ['form_component_values'], {
    name: 'idx_approval_instance_form_gin',
    method: 'gin',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('ding_approval_instance');
};
