/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createIndex(
    'ding_approval_instance',
    ['process_code', 'updated_at', 'process_instance_id'],
    {
      name: 'idx_approval_instance_process_updated_active',
      where: 'deleted_at IS NULL',
    }
  );
};

exports.down = (pgm) => {
  pgm.dropIndex('ding_approval_instance', ['process_code', 'updated_at', 'process_instance_id'], {
    name: 'idx_approval_instance_process_updated_active',
  });
};
