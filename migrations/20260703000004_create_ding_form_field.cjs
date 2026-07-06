/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('ding_form_field', {
    id: { type: 'BIGSERIAL', primaryKey: true },
    corp_id: { type: 'VARCHAR(64)', notNull: true },
    process_code: { type: 'VARCHAR(128)', notNull: true },
    field_id: { type: 'VARCHAR(128)', notNull: true },
    field_name: { type: 'VARCHAR(256)' },
    field_type: { type: 'VARCHAR(64)' },
    is_deleted: { type: 'BOOLEAN', default: 'false' },
    raw_payload: { type: 'JSONB' },
    updated_at: { type: 'TIMESTAMPTZ', default: pgm.func('now()') },
    created_at: { type: 'TIMESTAMPTZ', default: pgm.func('now()') },
  });

  pgm.addConstraint('ding_form_field', 'ding_form_field_corp_process_field_unique', {
    unique: ['corp_id', 'process_code', 'field_id'],
  });

  pgm.createIndex('ding_form_field', ['process_code']);
  pgm.createIndex('ding_form_field', ['corp_id', 'process_code']);
};

exports.down = (pgm) => {
  pgm.dropTable('ding_form_field');
};
