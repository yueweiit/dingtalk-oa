/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // Include deleted/retired records: incremental consumers need their tombstones.
  pgm.createIndex('ding_approval_instance', ['corp_id', 'updated_at', 'process_instance_id'], {
    name: 'approval_read_corp_updated_instance',
  });
  pgm.createIndex({ schema: 'costing_read', name: 'attachment_archive' },
    ['corp_id', 'updated_at', 'process_instance_id', 'file_id'], {
      name: 'attachment_read_corp_updated_instance_file',
    });
};

exports.down = (pgm) => {
  pgm.dropIndex({ schema: 'costing_read', name: 'attachment_archive' },
    ['corp_id', 'updated_at', 'process_instance_id', 'file_id'], {
      name: 'attachment_read_corp_updated_instance_file',
    });
  pgm.dropIndex('ding_approval_instance', ['corp_id', 'updated_at', 'process_instance_id'], {
    name: 'approval_read_corp_updated_instance',
  });
};
