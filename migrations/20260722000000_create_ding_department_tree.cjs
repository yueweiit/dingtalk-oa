/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('ding_department_tree', {
    id: { type: 'BIGSERIAL', primaryKey: true },
    corp_id: { type: 'VARCHAR(64)', notNull: true },
    dept_id: { type: 'VARCHAR(64)', notNull: true },
    parent_dept_id: { type: 'VARCHAR(64)' },
    name: { type: 'VARCHAR(500)', notNull: true },
    path_ids: { type: 'JSONB', notNull: true },
    path_names: { type: 'JSONB', notNull: true },
    is_current: { type: 'BOOLEAN', notNull: true, default: 'true' },
    last_sync_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('ding_department_tree', 'ding_department_tree_corp_dept_unique', {
    unique: ['corp_id', 'dept_id'],
  });
  pgm.createIndex('ding_department_tree', ['corp_id', 'parent_dept_id'], {
    name: 'idx_department_tree_parent',
  });
  pgm.createIndex('ding_department_tree', ['corp_id', 'is_current'], {
    name: 'idx_department_tree_current',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('ding_department_tree');
};
