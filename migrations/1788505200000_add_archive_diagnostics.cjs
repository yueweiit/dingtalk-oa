/* eslint-disable camelcase */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE costing_read.attachment_archive
      ADD COLUMN IF NOT EXISTS thumbnail_media_id varchar(512),
      ADD COLUMN IF NOT EXISTS archive_method varchar(64),
      ADD COLUMN IF NOT EXISTS content_quality varchar(16),
      ADD COLUMN IF NOT EXISTS failure_code varchar(128),
      ADD COLUMN IF NOT EXISTS last_attempt_strategy varchar(64),
      ADD COLUMN IF NOT EXISTS diagnostic_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS recovery_canary boolean NOT NULL DEFAULT false;

    ALTER TABLE costing_read.attachment_archive
      DROP CONSTRAINT IF EXISTS attachment_archive_content_quality_check;
    ALTER TABLE costing_read.attachment_archive
      ADD CONSTRAINT attachment_archive_content_quality_check
      CHECK (content_quality IS NULL OR content_quality IN ('original', 'preview'));

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
      a.updated_at,
      a.archive_method,
      a.content_quality,
      a.failure_code,
      a.last_attempt_strategy,
      a.diagnostic_json,
      a.recovery_canary
    FROM costing_read.attachment_archive a
    JOIN costing_read.allowed_process_template w USING (process_code)
    WHERE w.archive_attachments;

    DO $grant$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'costing_reader') THEN
        GRANT SELECT ON costing_read.attachment_archives_v1 TO costing_reader;
      END IF;
    END
    $grant$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP VIEW IF EXISTS costing_read.attachment_archives_v1;
    CREATE VIEW costing_read.attachment_archives_v1 AS
    SELECT
      a.corp_id, a.process_instance_id, a.process_code, a.attachment_origin,
      a.file_id, a.space_id, a.file_name, a.declared_size, a.bucket, a.object_key,
      a.actual_size, a.content_type, a.etag, a.sha256, a.archive_status, a.attempts,
      a.last_error, a.comment_user_id, a.comment_user_name, a.comment_time,
      a.comment_remark, a.archived_at, a.updated_at
    FROM costing_read.attachment_archive a
    JOIN costing_read.allowed_process_template w USING (process_code)
    WHERE w.archive_attachments;

    DO $grant$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'costing_reader') THEN
        GRANT SELECT ON costing_read.attachment_archives_v1 TO costing_reader;
      END IF;
    END
    $grant$;

    ALTER TABLE costing_read.attachment_archive
      DROP COLUMN IF EXISTS diagnostic_json,
      DROP COLUMN IF EXISTS last_attempt_strategy,
      DROP COLUMN IF EXISTS failure_code,
      DROP COLUMN IF EXISTS content_quality,
      DROP COLUMN IF EXISTS archive_method,
      DROP COLUMN IF EXISTS thumbnail_media_id,
      DROP COLUMN IF EXISTS recovery_canary;
  `);
};
