/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('ding_corp_config', {
    id: { type: 'BIGSERIAL', primaryKey: true },
    corp_id: { type: 'VARCHAR(64)', notNull: true, unique: true },
    corp_name: { type: 'VARCHAR(256)' },
    is_active: { type: 'BOOLEAN', default: 'true' },
    created_at: { type: 'TIMESTAMPTZ', default: pgm.func('now()') },
    updated_at: { type: 'TIMESTAMPTZ', default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('ding_corp_config');
};
