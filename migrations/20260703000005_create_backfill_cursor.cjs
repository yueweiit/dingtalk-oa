/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('backfill_cursor', {
    id: { type: 'BIGSERIAL', primaryKey: true },
    corp_id: { type: 'VARCHAR(64)', notNull: true },
    process_code: { type: 'VARCHAR(128)', notNull: true },
    window_start: { type: 'TIMESTAMPTZ', notNull: true },
    window_end: { type: 'TIMESTAMPTZ', notNull: true },
    status: { type: 'VARCHAR(32)', notNull: true, default: 'running' },
    cursor_offset: { type: 'INTEGER', default: 0 },
    processed_count: { type: 'INTEGER', default: 0 },
    started_at: { type: 'TIMESTAMPTZ', default: pgm.func('now()') },
    finished_at: { type: 'TIMESTAMPTZ' },
    error_message: { type: 'TEXT' },
    created_at: { type: 'TIMESTAMPTZ', default: pgm.func('now()') },
  });

  pgm.addConstraint('backfill_cursor', 'backfill_cursor_corp_process_window_unique', {
    unique: ['corp_id', 'process_code', 'window_start', 'window_end'],
  });

  pgm.createIndex('backfill_cursor', ['status']);
  pgm.createIndex('backfill_cursor', ['corp_id', 'process_code']);
};

exports.down = (pgm) => {
  pgm.dropTable('backfill_cursor');
};
