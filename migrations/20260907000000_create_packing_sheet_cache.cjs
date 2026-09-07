/* eslint-disable camelcase */
exports.shorthands = undefined;

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE SCHEMA IF NOT EXISTS costing_read;

    CREATE TABLE costing_read.allowed_packing_workbook (
      corp_id varchar(64) NOT NULL,
      workbook_id varchar(256) NOT NULL,
      year integer NOT NULL CHECK (year BETWEEN 2000 AND 2200),
      label varchar(500) NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (corp_id, workbook_id)
    );

    CREATE UNIQUE INDEX allowed_packing_workbook_year_enabled_uq
      ON costing_read.allowed_packing_workbook(corp_id, year)
      WHERE enabled;

    CREATE TABLE costing_read.packing_sheet_index (
      corp_id varchar(64) NOT NULL,
      workbook_id varchar(256) NOT NULL,
      sheet_id varchar(256) NOT NULL,
      sheet_name varchar(1000) NOT NULL,
      visibility varchar(64),
      source_updated_at timestamptz,
      indexed_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      PRIMARY KEY (corp_id, workbook_id, sheet_id),
      FOREIGN KEY (corp_id, workbook_id)
        REFERENCES costing_read.allowed_packing_workbook(corp_id, workbook_id)
        ON DELETE RESTRICT
    );

    CREATE INDEX packing_sheet_index_live_name_idx
      ON costing_read.packing_sheet_index(corp_id, workbook_id, sheet_name)
      WHERE deleted_at IS NULL;

    CREATE TABLE costing_read.packing_sheet_snapshot (
      id bigserial PRIMARY KEY,
      corp_id varchar(64) NOT NULL,
      workbook_id varchar(256) NOT NULL,
      sheet_id varchar(256) NOT NULL,
      sheet_name varchar(1000) NOT NULL,
      range_address varchar(128),
      capture_started_at timestamptz NOT NULL,
      capture_finished_at timestamptz NOT NULL,
      content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      bucket varchar(128) NOT NULL,
      object_key varchar(1500) NOT NULL,
      actual_size bigint NOT NULL CHECK (actual_size >= 0),
      row_count integer NOT NULL CHECK (row_count >= 0),
      column_count integer NOT NULL CHECK (column_count >= 0),
      source_last_non_empty_row integer,
      source_last_non_empty_column integer,
      capture_consistency varchar(32) NOT NULL
        CHECK (capture_consistency IN ('single_range', 'multi_range')),
      status varchar(32) NOT NULL
        CHECK (status IN ('ready', 'failed')),
      error_code varchar(256),
      error_message text,
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (corp_id, workbook_id, sheet_id)
        REFERENCES costing_read.packing_sheet_index(corp_id, workbook_id, sheet_id)
        ON DELETE RESTRICT,
      UNIQUE (corp_id, workbook_id, sheet_id, content_sha256),
      UNIQUE (bucket, object_key)
    );

    CREATE INDEX packing_sheet_snapshot_latest_idx
      ON costing_read.packing_sheet_snapshot(corp_id, workbook_id, sheet_id, created_at DESC)
      WHERE status = 'ready';

    CREATE TABLE costing_read.packing_refresh_request (
      id bigserial PRIMARY KEY,
      request_key varchar(64) NOT NULL UNIQUE CHECK (request_key ~ '^[0-9a-f]{64}$'),
      request_kind varchar(32) NOT NULL
        CHECK (request_kind IN ('workbook_index', 'sheet_snapshot')),
      corp_id varchar(64) NOT NULL,
      workbook_id varchar(256) NOT NULL,
      sheet_id varchar(256),
      requested_by varchar(256) NOT NULL,
      status varchar(32) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'success', 'failed')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      claimed_at timestamptz,
      completed_at timestamptz,
      error_code varchar(256),
      error_message text,
      snapshot_id bigint REFERENCES costing_read.packing_sheet_snapshot(id) ON DELETE RESTRICT,
      requested_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (corp_id, workbook_id)
        REFERENCES costing_read.allowed_packing_workbook(corp_id, workbook_id)
        ON DELETE RESTRICT,
      CHECK (
        (request_kind = 'workbook_index' AND sheet_id IS NULL)
        OR (request_kind = 'sheet_snapshot' AND sheet_id IS NOT NULL)
      )
    );

    CREATE INDEX packing_refresh_request_queue_idx
      ON costing_read.packing_refresh_request(status, requested_at, id)
      WHERE status IN ('pending', 'running');

    CREATE OR REPLACE VIEW costing_read.packing_workbooks_v1 AS
    SELECT corp_id, workbook_id, year, label, updated_at
      FROM costing_read.allowed_packing_workbook
     WHERE enabled;

    CREATE OR REPLACE VIEW costing_read.packing_sheet_index_v1 AS
    SELECT s.corp_id, s.workbook_id, w.year, w.label AS workbook_label,
           s.sheet_id, s.sheet_name, s.visibility, s.source_updated_at, s.indexed_at
      FROM costing_read.packing_sheet_index s
      JOIN costing_read.allowed_packing_workbook w
        USING (corp_id, workbook_id)
     WHERE w.enabled AND s.deleted_at IS NULL;

    CREATE OR REPLACE VIEW costing_read.packing_sheet_snapshots_v1 AS
    SELECT s.id, s.corp_id, s.workbook_id, s.sheet_id, s.sheet_name,
           s.range_address, s.capture_started_at, s.capture_finished_at,
           s.content_sha256, s.bucket, s.object_key, s.actual_size,
           s.row_count, s.column_count, s.source_last_non_empty_row,
           s.source_last_non_empty_column, s.capture_consistency,
           s.status, s.error_code, s.error_message, s.created_at,
           NOT EXISTS (
             SELECT 1
               FROM costing_read.packing_sheet_snapshot newer
              WHERE newer.corp_id = s.corp_id
                AND newer.workbook_id = s.workbook_id
                AND newer.sheet_id = s.sheet_id
                AND newer.status = 'ready'
                AND (newer.created_at, newer.id) > (s.created_at, s.id)
           ) AS is_latest
      FROM costing_read.packing_sheet_snapshot s
      JOIN costing_read.allowed_packing_workbook w
        USING (corp_id, workbook_id)
     WHERE w.enabled AND s.status = 'ready';

    CREATE OR REPLACE VIEW costing_read.packing_refresh_status_v1 AS
    SELECT id, request_key, request_kind, corp_id, workbook_id, sheet_id,
           requested_by, status, attempts, claimed_at, completed_at,
           error_code, error_message, snapshot_id, requested_at, updated_at
      FROM costing_read.packing_refresh_request;

    CREATE OR REPLACE FUNCTION costing_read.request_packing_workbook_index_refresh(
      p_workbook_id text,
      p_request_key text,
      p_requested_by text
    ) RETURNS bigint
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, costing_read
    AS $function$
    DECLARE
      v_corp_id varchar(64);
      v_request_id bigint;
    BEGIN
      IF p_request_key !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'invalid request key' USING ERRCODE = '22023';
      END IF;
      IF length(trim(COALESCE(p_requested_by, ''))) = 0 THEN
        RAISE EXCEPTION 'requested_by is required' USING ERRCODE = '22023';
      END IF;

      SELECT corp_id INTO v_corp_id
        FROM costing_read.allowed_packing_workbook
       WHERE workbook_id = p_workbook_id AND enabled
       ORDER BY corp_id
       LIMIT 1;
      IF v_corp_id IS NULL THEN
        RAISE EXCEPTION 'packing workbook is not allowed' USING ERRCODE = '42501';
      END IF;

      INSERT INTO costing_read.packing_refresh_request(
        request_key, request_kind, corp_id, workbook_id, sheet_id, requested_by
      ) VALUES (
        p_request_key, 'workbook_index', v_corp_id, p_workbook_id, NULL, p_requested_by
      )
      ON CONFLICT (request_key) DO NOTHING
      RETURNING id INTO v_request_id;

      IF v_request_id IS NULL THEN
        SELECT id INTO v_request_id
          FROM costing_read.packing_refresh_request
         WHERE request_key = p_request_key;
      END IF;
      RETURN v_request_id;
    END;
    $function$;

    CREATE OR REPLACE FUNCTION costing_read.request_packing_sheet_refresh(
      p_workbook_id text,
      p_sheet_id text,
      p_request_key text,
      p_requested_by text
    ) RETURNS bigint
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, costing_read
    AS $function$
    DECLARE
      v_corp_id varchar(64);
      v_request_id bigint;
    BEGIN
      IF p_request_key !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'invalid request key' USING ERRCODE = '22023';
      END IF;
      IF length(trim(COALESCE(p_requested_by, ''))) = 0 THEN
        RAISE EXCEPTION 'requested_by is required' USING ERRCODE = '22023';
      END IF;

      SELECT s.corp_id INTO v_corp_id
        FROM costing_read.packing_sheet_index s
        JOIN costing_read.allowed_packing_workbook w
          USING (corp_id, workbook_id)
       WHERE s.workbook_id = p_workbook_id
         AND s.sheet_id = p_sheet_id
         AND s.deleted_at IS NULL
         AND w.enabled
       ORDER BY s.corp_id
       LIMIT 1;
      IF v_corp_id IS NULL THEN
        RAISE EXCEPTION 'packing sheet is not allowed' USING ERRCODE = '42501';
      END IF;

      INSERT INTO costing_read.packing_refresh_request(
        request_key, request_kind, corp_id, workbook_id, sheet_id, requested_by
      ) VALUES (
        p_request_key, 'sheet_snapshot', v_corp_id, p_workbook_id, p_sheet_id, p_requested_by
      )
      ON CONFLICT (request_key) DO NOTHING
      RETURNING id INTO v_request_id;

      IF v_request_id IS NULL THEN
        SELECT id INTO v_request_id
          FROM costing_read.packing_refresh_request
         WHERE request_key = p_request_key;
      END IF;
      RETURN v_request_id;
    END;
    $function$;

    REVOKE ALL ON TABLE costing_read.allowed_packing_workbook FROM PUBLIC;
    REVOKE ALL ON TABLE costing_read.packing_sheet_index FROM PUBLIC;
    REVOKE ALL ON TABLE costing_read.packing_sheet_snapshot FROM PUBLIC;
    REVOKE ALL ON TABLE costing_read.packing_refresh_request FROM PUBLIC;
    REVOKE ALL ON FUNCTION costing_read.request_packing_workbook_index_refresh(text, text, text) FROM PUBLIC;
    REVOKE ALL ON FUNCTION costing_read.request_packing_sheet_refresh(text, text, text, text) FROM PUBLIC;

    DO $grants$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'costing_reader') THEN
        GRANT USAGE ON SCHEMA costing_read TO costing_reader;
        GRANT SELECT ON costing_read.packing_workbooks_v1,
                        costing_read.packing_sheet_index_v1,
                        costing_read.packing_sheet_snapshots_v1,
                        costing_read.packing_refresh_status_v1
          TO costing_reader;
      END IF;

      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'costing_job_submitter') THEN
        GRANT USAGE ON SCHEMA costing_read TO costing_job_submitter;
        GRANT EXECUTE ON FUNCTION costing_read.request_packing_workbook_index_refresh(text, text, text)
          TO costing_job_submitter;
        GRANT EXECUTE ON FUNCTION costing_read.request_packing_sheet_refresh(text, text, text, text)
          TO costing_job_submitter;
      END IF;
    END
    $grants$;
  `);
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS costing_read.request_packing_sheet_refresh(text, text, text, text);
    DROP FUNCTION IF EXISTS costing_read.request_packing_workbook_index_refresh(text, text, text);
    DROP VIEW IF EXISTS costing_read.packing_refresh_status_v1;
    DROP VIEW IF EXISTS costing_read.packing_sheet_snapshots_v1;
    DROP VIEW IF EXISTS costing_read.packing_sheet_index_v1;
    DROP VIEW IF EXISTS costing_read.packing_workbooks_v1;
    DROP TABLE IF EXISTS costing_read.packing_refresh_request;
    DROP TABLE IF EXISTS costing_read.packing_sheet_snapshot;
    DROP TABLE IF EXISTS costing_read.packing_sheet_index;
    DROP TABLE IF EXISTS costing_read.allowed_packing_workbook;
  `);
};
