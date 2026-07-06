/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('ding_approval_task', {
    id: { type: 'BIGSERIAL', primaryKey: true },
    corp_id: { type: 'VARCHAR(64)', notNull: true },
    process_instance_id: { type: 'VARCHAR(128)', notNull: true },
    task_id: { type: 'VARCHAR(128)', notNull: true },
    task_order: { type: 'INTEGER' },
    activity_id: { type: 'VARCHAR(128)' },
    node_name: { type: 'VARCHAR(256)' },
    status: { type: 'VARCHAR(32)' },
    result: { type: 'VARCHAR(32)' },
    approver_user_id: { type: 'VARCHAR(128)' },
    approver_user_name: { type: 'VARCHAR(256)' },
    approver_dept_id: { type: 'VARCHAR(128)' },
    approver_dept_name: { type: 'VARCHAR(256)' },
    start_time: { type: 'TIMESTAMPTZ' },
    end_time: { type: 'TIMESTAMPTZ' },
    remark: { type: 'TEXT' },
    raw_payload: { type: 'JSONB' },
    updated_at: { type: 'TIMESTAMPTZ', default: pgm.func('now()') },
    created_at: { type: 'TIMESTAMPTZ', default: pgm.func('now()') },
  });

  pgm.addConstraint('ding_approval_task', 'ding_approval_task_corp_instance_task_unique', {
    unique: ['corp_id', 'process_instance_id', 'task_id'],
  });

  pgm.createIndex('ding_approval_task', ['process_instance_id']);
  pgm.createIndex('ding_approval_task', ['approver_user_id']);
  pgm.createIndex('ding_approval_task', ['status']);
};

exports.down = (pgm) => {
  pgm.dropTable('ding_approval_task');
};
