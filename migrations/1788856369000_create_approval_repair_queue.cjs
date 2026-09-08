/* eslint-disable camelcase */
exports.shorthands = undefined;

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE costing_read.approval_repair_request (
      id bigserial PRIMARY KEY,
      request_key char(64) NOT NULL UNIQUE CHECK (request_key ~ '^[0-9a-f]{64}$'),
      corp_id varchar(64) NOT NULL,
      process_instance_id varchar(128) NOT NULL,
      expected_business_id varchar(128) NOT NULL,
      expected_process_code varchar(128) NOT NULL,
      expected_purpose varchar(64) NOT NULL
        CHECK (expected_purpose IN ('international_logistics', 'purchase_expense')),
      requested_by varchar(256) NOT NULL,
      trigger_source varchar(32) NOT NULL DEFAULT 'costing_audit'
        CHECK (trigger_source IN ('costing_audit', 'manual', 'linked_purchase')),
      status varchar(32) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'retry', 'success', 'manual_required')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
      next_attempt_at timestamptz,
      claimed_at timestamptz,
      completed_at timestamptz,
      error_code varchar(256),
      error_message text,
      fetched_business_id varchar(128),
      fetched_process_code varchar(128),
      requested_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (expected_process_code)
        REFERENCES costing_read.allowed_process_template(process_code)
        ON DELETE RESTRICT
    );

    CREATE INDEX approval_repair_request_queue_idx
      ON costing_read.approval_repair_request(status, next_attempt_at, requested_at, id)
      WHERE status IN ('pending', 'running', 'retry');
    CREATE INDEX approval_repair_request_instance_idx
      ON costing_read.approval_repair_request(corp_id, process_instance_id, requested_at DESC);

    CREATE OR REPLACE VIEW costing_read.approval_repair_status_v1 AS
    SELECT id, request_key, corp_id, process_instance_id, expected_business_id,
           expected_process_code, expected_purpose, requested_by, trigger_source,
           status, attempts, next_attempt_at, claimed_at, completed_at,
           error_code, error_message, fetched_business_id, fetched_process_code,
           requested_at, updated_at
      FROM costing_read.approval_repair_request;

    CREATE OR REPLACE FUNCTION costing_read.request_approval_repair(
      p_corp_id text,
      p_process_instance_id text,
      p_expected_business_id text,
      p_expected_process_code text,
      p_expected_purpose text,
      p_request_key text,
      p_requested_by text,
      p_trigger_source text DEFAULT 'costing_audit'
    ) RETURNS bigint
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, costing_read, public
    AS $function$
    DECLARE
      v_request_id bigint;
      v_expected_business_id text;
      v_expected_process_code text;
    BEGIN
      IF p_request_key !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'invalid request key' USING ERRCODE = '22023';
      END IF;
      IF length(trim(COALESCE(p_corp_id, ''))) = 0
         OR length(trim(COALESCE(p_process_instance_id, ''))) = 0
         OR length(trim(COALESCE(p_expected_business_id, ''))) = 0
         OR length(trim(COALESCE(p_expected_process_code, ''))) = 0
         OR length(trim(COALESCE(p_requested_by, ''))) = 0 THEN
        RAISE EXCEPTION 'repair request identifiers are required' USING ERRCODE = '22023';
      END IF;
      IF p_expected_purpose NOT IN ('international_logistics', 'purchase_expense') THEN
        RAISE EXCEPTION 'repair purpose is not allowed' USING ERRCODE = '42501';
      END IF;
      IF COALESCE(p_trigger_source, '') NOT IN ('costing_audit', 'manual', 'linked_purchase') THEN
        RAISE EXCEPTION 'repair trigger is not allowed' USING ERRCODE = '22023';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM costing_read.allowed_process_template allowed
         WHERE allowed.process_code = p_expected_process_code
           AND allowed.purpose = p_expected_purpose
      ) OR NOT EXISTS (
        SELECT 1 FROM public.ding_process_template template
         WHERE template.corp_id = p_corp_id
           AND template.process_code = p_expected_process_code
           AND template.enabled
           AND NOT template.is_deleted
      ) THEN
        RAISE EXCEPTION 'approval process template is not allowed' USING ERRCODE = '42501';
      END IF;

      -- 同一企业、实例和用途串行提交，防止重复点击产生并发任务。
      PERFORM pg_advisory_xact_lock(
        hashtextextended(concat_ws('|', p_corp_id, p_process_instance_id, p_expected_purpose), 0)
      );
      SELECT id, expected_business_id, expected_process_code
        INTO v_request_id, v_expected_business_id, v_expected_process_code
        FROM costing_read.approval_repair_request
       WHERE corp_id = p_corp_id
         AND process_instance_id = p_process_instance_id
         AND expected_purpose = p_expected_purpose
         AND status <> 'manual_required'
       ORDER BY requested_at DESC, id DESC
      LIMIT 1;
      IF v_request_id IS NOT NULL THEN
        IF v_expected_business_id <> p_expected_business_id
           OR v_expected_process_code <> p_expected_process_code THEN
          RAISE EXCEPTION 'existing repair request expectation mismatch' USING ERRCODE = '22023';
        END IF;
        RETURN v_request_id;
      END IF;

      INSERT INTO costing_read.approval_repair_request(
        request_key, corp_id, process_instance_id, expected_business_id,
        expected_process_code, expected_purpose, requested_by, trigger_source
      ) VALUES (
        p_request_key, p_corp_id, p_process_instance_id, p_expected_business_id,
        p_expected_process_code, p_expected_purpose, p_requested_by, p_trigger_source
      )
      ON CONFLICT (request_key) DO NOTHING
      RETURNING id INTO v_request_id;

      IF v_request_id IS NULL THEN
        SELECT id INTO v_request_id
          FROM costing_read.approval_repair_request
         WHERE request_key = p_request_key;
      END IF;
      RETURN v_request_id;
    END;
    $function$;

    REVOKE ALL ON TABLE costing_read.approval_repair_request FROM PUBLIC;
    REVOKE ALL ON FUNCTION costing_read.request_approval_repair(text,text,text,text,text,text,text,text) FROM PUBLIC;

    DO $grants$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'costing_reader') THEN
        GRANT USAGE ON SCHEMA costing_read TO costing_reader;
        GRANT SELECT ON costing_read.approval_repair_status_v1 TO costing_reader;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'costing_job_submitter') THEN
        GRANT USAGE ON SCHEMA costing_read TO costing_job_submitter;
        GRANT EXECUTE ON FUNCTION costing_read.request_approval_repair(text,text,text,text,text,text,text,text)
          TO costing_job_submitter;
      END IF;
    END
    $grants$;
  `);
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS costing_read.request_approval_repair(text,text,text,text,text,text,text,text);
    DROP VIEW IF EXISTS costing_read.approval_repair_status_v1;
    DROP TABLE IF EXISTS costing_read.approval_repair_request;
  `);
};
