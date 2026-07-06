/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('ding_user_snapshot', {
    id: { type: 'BIGSERIAL', primaryKey: true },
    corp_id: { type: 'VARCHAR(64)', notNull: true },
    user_id: { type: 'VARCHAR(128)', notNull: true },
    name: { type: 'VARCHAR(256)' },
    dept_id_list: { type: 'JSONB' },
    title: { type: 'VARCHAR(256)' },
    avatar: { type: 'TEXT' },
    snapshot_hash: { type: 'VARCHAR(64)', notNull: true },
    valid_from: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
    valid_to: { type: 'TIMESTAMPTZ' },
    is_current: { type: 'BOOLEAN', notNull: true, default: 'true' },
    fetch_status: { type: 'VARCHAR(32)', default: 'success' },
    fetch_error: { type: 'TEXT' },
    raw_payload: { type: 'JSONB' },
    updated_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('ding_user_snapshot', 'ding_user_snapshot_corp_user_hash_from_unique', {
    unique: ['corp_id', 'user_id', 'snapshot_hash', 'valid_from'],
  });

  pgm.createIndex('ding_user_snapshot', ['corp_id', 'user_id', 'is_current'], {
    name: 'idx_user_snapshot_current',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('ding_user_snapshot');
};
