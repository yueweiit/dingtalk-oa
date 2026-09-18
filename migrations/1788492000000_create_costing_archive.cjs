/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE SCHEMA IF NOT EXISTS costing_read;

    CREATE TABLE IF NOT EXISTS costing_read.allowed_process_template (
      process_code varchar(128) PRIMARY KEY,
      purpose varchar(64) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS costing_read.attachment_archive (
      id bigserial PRIMARY KEY,
      corp_id varchar(64) NOT NULL,
      process_instance_id varchar(128) NOT NULL,
      process_code varchar(128) NOT NULL,
      attachment_origin varchar(16) NOT NULL CHECK (attachment_origin IN ('form', 'comment')),
      file_id varchar(256) NOT NULL,
      space_id varchar(256),
      file_name varchar(1000),
      declared_size bigint,
      bucket varchar(128) NOT NULL,
      object_key varchar(1200) NOT NULL,
      actual_size bigint,
      content_type varchar(255),
      etag varchar(255),
      sha256 char(64),
      archive_status varchar(32) NOT NULL DEFAULT 'pending'
        CHECK (archive_status IN ('pending', 'archiving', 'archived', 'retry', 'manual_required')),
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      comment_user_id varchar(128),
      comment_user_name varchar(256),
      comment_time timestamptz,
      comment_remark text,
      claimed_at timestamptz,
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (corp_id, process_instance_id, file_id),
      UNIQUE (bucket, object_key)
    );
    CREATE INDEX IF NOT EXISTS idx_costing_attachment_archive_queue
      ON costing_read.attachment_archive (archive_status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_costing_attachment_archive_instance
      ON costing_read.attachment_archive (process_instance_id, file_id);

    CREATE TABLE IF NOT EXISTS costing_read.dingtalk_api_usage (
      id bigserial PRIMARY KEY,
      api_name varchar(128) NOT NULL,
      success boolean NOT NULL,
      called_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_costing_api_usage_called_at
      ON costing_read.dingtalk_api_usage (called_at, api_name);

    CREATE TABLE IF NOT EXISTS costing_read.archive_sync_health (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      last_started_at timestamptz,
      last_completed_at timestamptz,
      last_success_at timestamptz,
      last_error text,
      scanned_count integer NOT NULL DEFAULT 0,
      processed_count integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO costing_read.archive_sync_health(singleton)
    VALUES (true) ON CONFLICT (singleton) DO NOTHING;

    CREATE OR REPLACE VIEW costing_read.approval_instances_v1 AS
    SELECT
      i.corp_id,
      i.process_instance_id,
      COALESCE(i.raw_payload->>'businessId', i.raw_payload->>'business_id') AS business_id,
      i.process_code,
      i.title,
      i.status,
      i.result,
      i.originator_user_id,
      i.originator_user_name,
      i.originator_dept_id,
      i.originator_dept_name,
      i.create_time,
      i.finish_time,
      i.form_component_values,
      i.raw_payload,
      i.last_event_time,
      i.updated_at
    FROM public.ding_approval_instance i
    JOIN costing_read.allowed_process_template w USING (process_code)
    WHERE i.deleted_at IS NULL;

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

    CREATE OR REPLACE VIEW costing_read.sync_health_v1 AS
    SELECT
      h.last_started_at,
      h.last_completed_at,
      h.last_success_at,
      h.last_error,
      h.scanned_count,
      h.processed_count,
      (SELECT max(updated_at) FROM costing_read.approval_instances_v1) AS source_updated_at,
      EXTRACT(EPOCH FROM (now() - (SELECT max(updated_at) FROM costing_read.approval_instances_v1)))::bigint
        AS source_lag_seconds,
      count(*) FILTER (WHERE a.archive_status = 'pending')::integer AS pending_count,
      count(*) FILTER (WHERE a.archive_status = 'retry')::integer AS retry_count,
      count(*) FILTER (WHERE a.archive_status = 'manual_required')::integer AS manual_required_count,
      count(*) FILTER (WHERE a.archive_status = 'archived')::integer AS archived_count,
      (SELECT count(*)::integer FROM costing_read.dingtalk_api_usage
        WHERE called_at >= date_trunc('day', now())) AS api_calls_today,
      (SELECT count(*)::integer FROM costing_read.dingtalk_api_usage
        WHERE called_at >= date_trunc('month', now())) AS api_calls_this_month,
      h.updated_at
    FROM costing_read.archive_sync_health h
    LEFT JOIN costing_read.attachment_archive a ON true
    GROUP BY h.singleton, h.last_started_at, h.last_completed_at, h.last_success_at,
      h.last_error, h.scanned_count, h.processed_count, h.updated_at;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP VIEW IF EXISTS costing_read.sync_health_v1;
    DROP VIEW IF EXISTS costing_read.attachment_archives_v1;
    DROP VIEW IF EXISTS costing_read.approval_instances_v1;
    DROP TABLE IF EXISTS costing_read.archive_sync_health;
    DROP TABLE IF EXISTS costing_read.dingtalk_api_usage;
    DROP TABLE IF EXISTS costing_read.attachment_archive;
    DROP TABLE IF EXISTS costing_read.allowed_process_template;
    DROP SCHEMA IF EXISTS costing_read;
  `);
};
