/* eslint-disable camelcase */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE costing_read.allowed_process_template
      ADD COLUMN IF NOT EXISTS archive_attachments boolean NOT NULL DEFAULT false;

    UPDATE costing_read.allowed_process_template
       SET archive_attachments = (purpose = 'international_logistics');

    DELETE FROM costing_read.attachment_archive a
     WHERE NOT EXISTS (
       SELECT 1
         FROM costing_read.allowed_process_template w
        WHERE w.process_code = a.process_code
          AND w.archive_attachments
     );

    CREATE OR REPLACE VIEW costing_read.attachment_archives_v1 AS
    SELECT
      a.corp_id,
      a.process_instance_id,
      a.process_code,
      a.attachment_origin,
      a.file_id,
      a.space_id,
      a.file_name,
      a.declared_size,
      a.bucket,
      a.object_key,
      a.actual_size,
      a.content_type,
      a.etag,
      a.sha256,
      a.archive_status,
      a.attempts,
      a.last_error,
      a.comment_user_id,
      a.comment_user_name,
      a.comment_time,
      a.comment_remark,
      a.archived_at,
      a.updated_at
    FROM costing_read.attachment_archive a
    JOIN costing_read.allowed_process_template w USING (process_code)
    WHERE w.archive_attachments;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE VIEW costing_read.attachment_archives_v1 AS
    SELECT
      a.corp_id,
      a.process_instance_id,
      a.process_code,
      a.attachment_origin,
      a.file_id,
      a.space_id,
      a.file_name,
      a.declared_size,
      a.bucket,
      a.object_key,
      a.actual_size,
      a.content_type,
      a.etag,
      a.sha256,
      a.archive_status,
      a.attempts,
      a.last_error,
      a.comment_user_id,
      a.comment_user_name,
      a.comment_time,
      a.comment_remark,
      a.archived_at,
      a.updated_at
    FROM costing_read.attachment_archive a
    JOIN costing_read.allowed_process_template w USING (process_code);

    ALTER TABLE costing_read.allowed_process_template
      DROP COLUMN IF EXISTS archive_attachments;
  `);
};
