exports.up = (pgm) => {
  pgm.sql(`
    -- Accept a category path or the known parent/service-child fields, never remarks.
    CREATE FUNCTION costing_read.is_logistics_purchase(components jsonb)
    RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
      WITH fields AS (
        SELECT lower(COALESCE(c->>'name', '')) AS name, lower(COALESCE(c->>'value', '')) AS value
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(components) = 'array' THEN components ELSE '[]'::jsonb END
        ) c
      ), parents AS (
        SELECT value FROM fields WHERE name ~
          '(采购类型|采购类别|采购分类|采购支出|gastos de compra|tipo de compra|categoría de compra|categoria de compra)'
      )
      SELECT EXISTS (
        SELECT 1 FROM parents p
        WHERE p.value ~ '(服务类采购|compra de servicios)'
          AND p.value !~ '(商品类采购|compra de mercancías|compra de mercancias)'
          AND (
            p.value ~ '(物流及运输服务|servicios de logística y transporte|servicios de logistica y transporte)'
            OR EXISTS (
              SELECT 1 FROM fields f
              WHERE f.name ~ '(服务类采购|adquisiciones de servicios|compra de servicios)'
                AND f.value ~ '(物流及运输服务|servicios de logística y transporte|servicios de logistica y transporte)'
            )
          )
      )
    $fn$;

    CREATE VIEW costing_read.approval_instances_v2 AS
    SELECT i.corp_id, i.process_instance_id,
      COALESCE(i.raw_payload->>'businessId', i.raw_payload->>'business_id') AS business_id,
      i.process_code, i.title, i.status, i.result,
      i.originator_user_id, i.originator_user_name, i.originator_dept_id, i.originator_dept_name,
      i.create_time, i.finish_time, i.form_component_values, i.raw_payload,
      i.last_event_time, i.updated_at, i.deleted_at
    FROM public.ding_approval_instance i
    JOIN costing_read.allowed_process_template w USING (process_code);

    CREATE VIEW costing_read.eligible_attachment_instances AS
    SELECT i.* FROM public.ding_approval_instance i
    JOIN costing_read.allowed_process_template w USING (process_code)
    WHERE i.deleted_at IS NULL AND (
      (w.purpose = 'international_logistics' AND w.archive_attachments)
      OR (w.purpose = 'purchase_expense' AND costing_read.is_logistics_purchase(
        COALESCE(i.form_component_values, i.raw_payload->'formComponentValues', i.raw_payload->'form_component_values')
      ))
    );

    ALTER TABLE costing_read.attachment_archive ADD COLUMN retired_at timestamptz;

    -- A successful no-op poll must not masquerade as a changed source record.
    CREATE FUNCTION costing_read.track_approval_source_change()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF (to_jsonb(NEW) - 'updated_at' - 'last_event_time') IS DISTINCT FROM
         (to_jsonb(OLD) - 'updated_at' - 'last_event_time') THEN
        NEW.updated_at := clock_timestamp();
      ELSE
        NEW.updated_at := OLD.updated_at;
      END IF;
      RETURN NEW;
    END
    $fn$;
    CREATE TRIGGER costing_approval_source_change BEFORE UPDATE ON public.ding_approval_instance
      FOR EACH ROW EXECUTE FUNCTION costing_read.track_approval_source_change();

    CREATE VIEW costing_read.attachment_archives_v2 AS
    SELECT a.corp_id, a.process_instance_id, a.process_code, a.attachment_origin,
      a.file_id, a.space_id, a.file_name, a.declared_size, a.bucket, a.object_key,
      a.actual_size, a.content_type, a.etag, a.sha256, a.archive_status, a.attempts,
      a.last_error, a.comment_user_id, a.comment_user_name, a.comment_time,
      a.comment_remark, a.archived_at, a.updated_at, a.archive_method,
      a.content_quality, a.failure_code, a.last_attempt_strategy, a.diagnostic_json,
      a.recovery_canary, a.retired_at
    FROM costing_read.attachment_archive a
    JOIN costing_read.allowed_process_template w USING (process_code);

    CREATE OR REPLACE VIEW costing_read.attachment_archives_v1 AS
    SELECT a.corp_id, a.process_instance_id, a.process_code, a.attachment_origin,
      a.file_id, a.space_id, a.file_name, a.declared_size, a.bucket, a.object_key,
      a.actual_size, a.content_type, a.etag, a.sha256, a.archive_status, a.attempts,
      a.last_error, a.comment_user_id, a.comment_user_name, a.comment_time,
      a.comment_remark, a.archived_at, a.updated_at, a.archive_method,
      a.content_quality, a.failure_code, a.last_attempt_strategy, a.diagnostic_json,
      a.recovery_canary
    FROM costing_read.attachment_archives_v2 a
    WHERE a.retired_at IS NULL AND EXISTS (
      SELECT 1 FROM costing_read.eligible_attachment_instances i
      WHERE i.corp_id = a.corp_id AND i.process_instance_id = a.process_instance_id
    );

    CREATE FUNCTION costing_read.requeue_changed_attachment()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF (NEW.space_id, NEW.file_name, NEW.declared_size, NEW.thumbnail_media_id) IS DISTINCT FROM
         (OLD.space_id, OLD.file_name, OLD.declared_size, OLD.thumbnail_media_id) THEN
        NEW.object_key := split_part(NEW.object_key, '/revision-', 1) || '/revision-' ||
          md5(jsonb_build_array(NEW.space_id, NEW.file_name, NEW.declared_size, NEW.thumbnail_media_id)::text);
        NEW.archive_status := 'pending';
        NEW.attempts := 0;
        NEW.claimed_at := NULL;
        NEW.archived_at := NULL;
        NEW.actual_size := NULL;
        NEW.content_type := NULL;
        NEW.etag := NULL;
        NEW.sha256 := NULL;
        NEW.archive_method := NULL;
        NEW.content_quality := NULL;
        NEW.failure_code := NULL;
        NEW.last_error := NULL;
        NEW.last_attempt_strategy := NULL;
        NEW.diagnostic_json := '[]'::jsonb;
        NEW.recovery_canary := false;
        NEW.updated_at := clock_timestamp();
      END IF;
      RETURN NEW;
    END
    $fn$;
    CREATE TRIGGER costing_attachment_descriptor_change BEFORE UPDATE ON costing_read.attachment_archive
      FOR EACH ROW EXECUTE FUNCTION costing_read.requeue_changed_attachment();

    UPDATE costing_read.attachment_archive a
    SET retired_at=clock_timestamp(), updated_at=clock_timestamp()
    WHERE a.retired_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM costing_read.eligible_attachment_instances i
      WHERE i.corp_id=a.corp_id AND i.process_instance_id=a.process_instance_id
    );

    CREATE TABLE costing_read.completed_approval_refresh (
      corp_id varchar(64) NOT NULL,
      process_instance_id varchar(128) NOT NULL,
      last_checked_at timestamptz,
      last_success_at timestamptz,
      last_error text,
      lease_until timestamptz,
      lease_generation bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (corp_id, process_instance_id)
    );
    CREATE INDEX completed_approval_refresh_rotation
      ON costing_read.completed_approval_refresh(last_checked_at, corp_id, process_instance_id);
    CREATE VIEW costing_read.completed_approval_refresh_v1 AS
      SELECT r.corp_id, r.process_instance_id, r.last_checked_at, r.last_success_at, r.last_error, r.lease_until
      FROM costing_read.completed_approval_refresh r
      JOIN costing_read.approval_instances_v2 i USING (corp_id, process_instance_id);

    DO $grant$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'costing_reader') THEN
        GRANT USAGE ON SCHEMA costing_read TO costing_reader;
        GRANT SELECT ON costing_read.approval_instances_v2, costing_read.attachment_archives_v2,
          costing_read.completed_approval_refresh_v1 TO costing_reader;
      END IF;
    END
    $grant$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE VIEW costing_read.attachment_archives_v1 AS
    SELECT a.corp_id, a.process_instance_id, a.process_code, a.attachment_origin,
      a.file_id, a.space_id, a.file_name, a.declared_size, a.bucket, a.object_key,
      a.actual_size, a.content_type, a.etag, a.sha256, a.archive_status, a.attempts,
      a.last_error, a.comment_user_id, a.comment_user_name, a.comment_time,
      a.comment_remark, a.archived_at, a.updated_at, a.archive_method,
      a.content_quality, a.failure_code, a.last_attempt_strategy, a.diagnostic_json,
      a.recovery_canary
    FROM costing_read.attachment_archive a
    JOIN costing_read.allowed_process_template w USING (process_code)
    WHERE w.archive_attachments;
    DROP TRIGGER IF EXISTS costing_attachment_descriptor_change ON costing_read.attachment_archive;
    DROP FUNCTION IF EXISTS costing_read.requeue_changed_attachment();
    DROP VIEW IF EXISTS costing_read.completed_approval_refresh_v1;
    DROP TABLE IF EXISTS costing_read.completed_approval_refresh;
    DROP VIEW IF EXISTS costing_read.attachment_archives_v2;
    DROP TRIGGER IF EXISTS costing_approval_source_change ON public.ding_approval_instance;
    DROP FUNCTION IF EXISTS costing_read.track_approval_source_change();
    ALTER TABLE costing_read.attachment_archive DROP COLUMN IF EXISTS retired_at;
    DROP VIEW IF EXISTS costing_read.eligible_attachment_instances;
    DROP VIEW IF EXISTS costing_read.approval_instances_v2;
    DROP FUNCTION IF EXISTS costing_read.is_logistics_purchase(jsonb);
  `);
};
