/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('ding_process_template', {
    id: { type: 'BIGSERIAL', primaryKey: true },
    corp_id: { type: 'VARCHAR(64)', notNull: true },
    process_code: { type: 'VARCHAR(128)', notNull: true },
    name: { type: 'VARCHAR(255)' },
    enabled: { type: 'BOOLEAN', default: 'true' },
    is_deleted: { type: 'BOOLEAN', default: 'false' },
    remark: { type: 'TEXT' },
    last_sync_at: { type: 'TIMESTAMPTZ' },
    updated_at: { type: 'TIMESTAMPTZ', default: pgm.func('now()') },
    created_at: { type: 'TIMESTAMPTZ', default: pgm.func('now()') },
  });

  pgm.addConstraint('ding_process_template', 'ding_process_template_corp_process_unique', {
    unique: ['corp_id', 'process_code'],
  });

  pgm.createIndex('ding_process_template', ['corp_id', 'enabled']);
  pgm.createIndex('ding_process_template', ['process_code']);
};

exports.down = (pgm) => {
  pgm.dropTable('ding_process_template');
};
