/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE costing_read.attachment_archive
      ADD COLUMN queue_priority smallint NOT NULL DEFAULT 0 CHECK (queue_priority IN (0, 1));
    CREATE INDEX attachment_archive_queue_priority
      ON costing_read.attachment_archive (queue_priority DESC, updated_at, id)
      WHERE retired_at IS NULL AND attempts < 5
        AND archive_status IN ('pending', 'retry', 'archiving');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX costing_read.attachment_archive_queue_priority;
    ALTER TABLE costing_read.attachment_archive DROP COLUMN queue_priority;
  `);
};
