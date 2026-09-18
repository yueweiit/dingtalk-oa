/** Purchase name scope and explicit logistics-service child classification. */
exports.up = (pgm) => {
  pgm.sql(`
    -- Capture only previously qualified rows; the upgrade must not invalidate unchanged source snapshots.
    CREATE TEMP TABLE prior_logistics_purchases ON COMMIT DROP AS
    SELECT i.corp_id, i.process_instance_id
    FROM public.ding_approval_instance i JOIN costing_read.allowed_process_template w USING (process_code)
    WHERE w.purpose='purchase_expense' AND costing_read.is_logistics_purchase(
      COALESCE(i.form_component_values,i.raw_payload->'formComponentValues',i.raw_payload->'form_component_values'));

    ALTER TABLE costing_read.allowed_process_template
      ADD COLUMN auto_registered_purchase boolean NOT NULL DEFAULT false;
    CREATE TABLE costing_read.purchase_template_scope (
      corp_id varchar(64) NOT NULL,
      process_code varchar(128) NOT NULL,
      registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (corp_id, process_code)
    );
    CREATE TABLE costing_read.purchase_approval_exposure (
      corp_id varchar(64) NOT NULL,
      process_instance_id varchar(128) NOT NULL,
      exposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (corp_id, process_instance_id)
    );

    CREATE FUNCTION costing_read.register_purchase_template()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog AS $fn$
    BEGIN
      IF position('采购支出' IN COALESCE(NEW.name, '')) > 0 THEN
        INSERT INTO costing_read.allowed_process_template(process_code,purpose,archive_attachments,auto_registered_purchase)
          VALUES (NEW.process_code,'purchase_expense',false,true) ON CONFLICT (process_code) DO NOTHING;
        INSERT INTO costing_read.purchase_template_scope(corp_id,process_code)
          VALUES (NEW.corp_id,NEW.process_code) ON CONFLICT (corp_id,process_code) DO NOTHING;
      END IF;
      RETURN NEW;
    END $fn$;
    REVOKE ALL ON FUNCTION costing_read.register_purchase_template() FROM PUBLIC;
    REVOKE ALL ON TABLE costing_read.purchase_template_scope, costing_read.purchase_approval_exposure FROM PUBLIC;
    CREATE TRIGGER costing_register_purchase_template
      AFTER INSERT OR UPDATE OF name,corp_id,process_code ON public.ding_process_template
      FOR EACH ROW EXECUTE FUNCTION costing_read.register_purchase_template();

    -- Include deleted/disabled metadata. Registry membership deliberately survives later metadata removal.
    INSERT INTO costing_read.allowed_process_template(process_code,purpose,archive_attachments,auto_registered_purchase)
      SELECT DISTINCT process_code,'purchase_expense',false,true FROM public.ding_process_template
      WHERE position('采购支出' IN COALESCE(name, '')) > 0 ON CONFLICT (process_code) DO NOTHING;
    INSERT INTO costing_read.purchase_template_scope(corp_id,process_code)
      SELECT corp_id,process_code FROM public.ding_process_template
      WHERE position('采购支出' IN COALESCE(name, '')) > 0 ON CONFLICT (corp_id,process_code) DO NOTHING;

    CREATE FUNCTION costing_read.purchase_category_path(field_value jsonb)
    RETURNS text[] LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path = pg_catalog AS $fn$
    DECLARE value_text text; path text[];
    BEGIN
      IF jsonb_typeof(field_value) = 'string' THEN
        value_text := btrim(field_value #>> '{}');
        IF left(value_text, 1) = '[' THEN
          BEGIN field_value := value_text::jsonb;
          EXCEPTION WHEN invalid_text_representation THEN RETURN NULL; END;
        ELSE
          path := regexp_split_to_array(lower(regexp_replace(value_text, '[[:space:]]+', '', 'g')), '(→|->|>|/|／)');
        END IF;
      END IF;
      IF path IS NULL THEN
        IF jsonb_typeof(field_value) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(field_value) v WHERE jsonb_typeof(v) <> 'string') THEN
          RETURN NULL;
        END IF;
        SELECT array_agg(lower(regexp_replace(value, '[[:space:]]+', '', 'g')) ORDER BY ordinal)
          INTO path FROM jsonb_array_elements_text(field_value) WITH ORDINALITY AS v(value, ordinal);
      END IF;
      IF COALESCE(cardinality(path), 0) NOT IN (1, 2) THEN RETURN NULL; END IF;
      RETURN path;
    END $fn$;

    CREATE OR REPLACE FUNCTION costing_read.is_logistics_purchase(components jsonb)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path = pg_catalog AS $fn$
    DECLARE
      parent_names text[] := ARRAY[
        '采购类型', '采购类别', '采购分类', '采购支出',
        'tipodecompra', 'categoríadecompra', 'categoriadecompra', 'gastosdecompra',
        '采购类型tipodecompra', '采购类别categoríadecompra', '采购类别categoriadecompra',
        '采购分类categoríadecompra', '采购分类categoriadecompra', '采购支出gastosdecompra'
      ];
      child_names text[] := ARRAY[
        '服务类采购', 'adquisicionesdeservicios', 'compradeservicios',
        '服务类采购adquisicionesdeservicios', '服务类采购compradeservicios'
      ];
      service_values text[] := ARRAY[
        '服务类采购', 'compradeservicios', '服务类采购compradeservicios',
        '服务商采购', 'compradeproveedores', '服务商采购compradeproveedores', '服务商采购compradeservicios'
      ];
      logistics_values text[] := ARRAY[
        '物流及运输服务', 'serviciosdelogísticaytransporte', 'serviciosdelogisticaytransporte',
        '物流及运输服务serviciosdelogísticaytransporte', '物流及运输服务serviciosdelogisticaytransporte'
      ];
      component jsonb; field_name text; path text[]; complete_path boolean := false;
    BEGIN
      IF jsonb_typeof(components) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      -- The exact selected service child is sufficient; historical parent aliases do not veto it.
      FOR component IN SELECT value FROM jsonb_array_elements(components) LOOP
        field_name := lower(regexp_replace(COALESCE(component->>'name', ''), '[[:space:]]+', '', 'g'));
        IF field_name = ANY(child_names) THEN
          path := costing_read.purchase_category_path(component->'value');
          IF cardinality(path) = 1 AND path[1] = ANY(logistics_values) THEN RETURN true; END IF;
        END IF;
      END LOOP;
      -- Preserve legacy complete paths, including rejection of conflicting parent-only evidence.
      FOR component IN SELECT value FROM jsonb_array_elements(components) LOOP
        field_name := lower(regexp_replace(COALESCE(component->>'name', ''), '[[:space:]]+', '', 'g'));
        IF NOT (field_name = ANY(parent_names)) THEN CONTINUE; END IF;
        path := costing_read.purchase_category_path(component->'value');
        IF path IS NULL OR NOT (path[1] = ANY(service_values)) THEN RETURN false; END IF;
        IF cardinality(path) = 2 THEN
          IF NOT (path[2] = ANY(logistics_values)) THEN RETURN false; END IF;
          complete_path := true;
        END IF;
      END LOOP;
      RETURN complete_path;
    END $fn$;

    -- Scope registration timestamps already wake newly exposed templates. Only changed classification
    -- on a previously manual allowlist needs an additional per-approval exposure marker.
    INSERT INTO costing_read.purchase_approval_exposure(corp_id,process_instance_id)
    SELECT i.corp_id,i.process_instance_id FROM public.ding_approval_instance i
    JOIN costing_read.allowed_process_template w USING (process_code)
    WHERE w.purpose='purchase_expense' AND NOT w.auto_registered_purchase
      AND costing_read.is_logistics_purchase(
        COALESCE(i.form_component_values,i.raw_payload->'formComponentValues',i.raw_payload->'form_component_values'))
      AND NOT EXISTS (SELECT 1 FROM pg_temp.prior_logistics_purchases p
        WHERE p.corp_id=i.corp_id AND p.process_instance_id=i.process_instance_id);

    CREATE OR REPLACE VIEW costing_read.approval_instances_v2 AS
    SELECT i.corp_id, i.process_instance_id,
      COALESCE(i.raw_payload->>'businessId', i.raw_payload->>'business_id') AS business_id,
      i.process_code, i.title, i.status, i.result,
      i.originator_user_id, i.originator_user_name, i.originator_dept_id, i.originator_dept_name,
      i.create_time, i.finish_time, i.form_component_values, i.raw_payload, i.last_event_time,
      GREATEST(i.updated_at, CASE WHEN w.auto_registered_purchase THEN s.registered_at END, e.exposed_at) AS updated_at,
      i.deleted_at
    FROM public.ding_approval_instance i
    JOIN costing_read.allowed_process_template w USING (process_code)
    LEFT JOIN costing_read.purchase_template_scope s USING (corp_id, process_code)
    LEFT JOIN costing_read.purchase_approval_exposure e USING (corp_id, process_instance_id)
    WHERE NOT w.auto_registered_purchase OR s.process_code IS NOT NULL;

    CREATE OR REPLACE VIEW costing_read.approval_instances_v1 AS
    SELECT corp_id, process_instance_id, business_id, process_code, title, status, result,
      originator_user_id, originator_user_name, originator_dept_id, originator_dept_name,
      create_time, finish_time, form_component_values, raw_payload, last_event_time, updated_at
    FROM costing_read.approval_instances_v2 WHERE deleted_at IS NULL;

    CREATE OR REPLACE VIEW costing_read.eligible_attachment_instances AS
    SELECT i.* FROM public.ding_approval_instance i
    JOIN costing_read.allowed_process_template w USING (process_code)
    WHERE i.deleted_at IS NULL
      AND (NOT w.auto_registered_purchase OR EXISTS (
        SELECT 1 FROM costing_read.purchase_template_scope s WHERE s.corp_id=i.corp_id AND s.process_code=i.process_code
      )) AND (
      (w.purpose = 'international_logistics' AND w.archive_attachments)
      OR (w.purpose = 'purchase_expense'
        AND upper(COALESCE(i.status, i.raw_payload->>'status', '')) NOT IN
          ('TERMINATED','CANCELED','CANCELLED','DELETED','REJECTED')
        AND lower(COALESCE(i.result, i.raw_payload->>'result', '')) NOT IN ('refuse','reject','disagree')
        AND costing_read.is_logistics_purchase(
          COALESCE(i.form_component_values, i.raw_payload->'formComponentValues', i.raw_payload->'form_component_values')
        ))
    );

    CREATE OR REPLACE VIEW costing_read.attachment_archives_v2 AS
    SELECT a.corp_id, a.process_instance_id, a.process_code, a.attachment_origin,
      a.file_id, a.space_id, a.file_name, a.declared_size, a.bucket, a.object_key,
      a.actual_size, a.content_type, a.etag, a.sha256, a.archive_status, a.attempts,
      a.last_error, a.comment_user_id, a.comment_user_name, a.comment_time,
      a.comment_remark, a.archived_at, a.updated_at, a.archive_method,
      a.content_quality, a.failure_code, a.last_attempt_strategy, a.diagnostic_json,
      a.recovery_canary, a.retired_at
    FROM costing_read.attachment_archive a
    JOIN costing_read.allowed_process_template w USING (process_code)
    WHERE NOT w.auto_registered_purchase OR EXISTS (
      SELECT 1 FROM costing_read.purchase_template_scope s WHERE s.corp_id=a.corp_id AND s.process_code=a.process_code
    );

    DO $actor$ BEGIN
      IF to_regclass('costing_read.approval_actor_names_v1') IS NOT NULL THEN
        EXECUTE $view$
    CREATE OR REPLACE VIEW costing_read.approval_actor_names_v1
    WITH (security_barrier = true) AS
    WITH actor_refs AS (
      SELECT i.corp_id, i.originator_user_id AS user_id
        FROM costing_read.approval_instances_v2 i
       WHERE i.deleted_at IS NULL
         AND NULLIF(BTRIM(i.originator_user_id), '') IS NOT NULL
      UNION
      SELECT i.corp_id,
             COALESCE(
               operation->>'userId',
               operation->>'user_id',
               operation->>'operatorUserId'
             ) AS user_id
        FROM costing_read.approval_instances_v2 i
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE
           WHEN jsonb_typeof(COALESCE(
             i.raw_payload->'operationRecords',
             i.raw_payload->'operation_records',
             i.raw_payload->'comments'
           )) = 'array'
           THEN COALESCE(
             i.raw_payload->'operationRecords',
             i.raw_payload->'operation_records',
             i.raw_payload->'comments'
           )
           ELSE '[]'::jsonb
         END
       ) operation
       WHERE i.deleted_at IS NULL
         AND NULLIF(BTRIM(COALESCE(
           operation->>'userId',
           operation->>'user_id',
           operation->>'operatorUserId'
         )), '') IS NOT NULL
      UNION
      SELECT a.corp_id, a.comment_user_id AS user_id
        FROM costing_read.attachment_archives_v2 a
       WHERE NULLIF(BTRIM(a.comment_user_id), '') IS NOT NULL
    ), ranked_names AS (
      SELECT refs.corp_id::text AS corp_id,
             refs.user_id::text AS user_id,
             u.name::text AS name,
             u.title::text AS title,
             u.valid_from,
             u.valid_to,
             u.is_current,
             ROW_NUMBER() OVER (
               PARTITION BY refs.corp_id, refs.user_id
               ORDER BY u.is_current DESC, u.valid_from DESC, u.updated_at DESC, u.id DESC
             ) AS preference
        FROM actor_refs refs
        JOIN public.ding_user_snapshot u
          ON u.corp_id = refs.corp_id
         AND u.user_id = refs.user_id
       WHERE u.fetch_status = 'success'
         AND NULLIF(BTRIM(u.name), '') IS NOT NULL
         AND LOWER(BTRIM(u.name)) <> 'unknown'
    )
    SELECT corp_id, user_id, name, title, valid_from, valid_to, is_current
      FROM ranked_names
     WHERE preference = 1;

        $view$;
      END IF;
    END $actor$;

    CREATE FUNCTION costing_read.enforce_purchase_repair_scope()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    BEGIN
      IF EXISTS (SELECT 1 FROM costing_read.allowed_process_template w
        WHERE w.process_code=NEW.expected_process_code AND w.auto_registered_purchase)
        AND NOT EXISTS (SELECT 1 FROM costing_read.purchase_template_scope s
          WHERE s.corp_id=NEW.corp_id AND s.process_code=NEW.expected_process_code) THEN
        RAISE EXCEPTION 'approval process template is not allowed for this corporation' USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END $fn$;
    REVOKE ALL ON FUNCTION costing_read.enforce_purchase_repair_scope() FROM PUBLIC;
    DO $repair$ BEGIN
      IF to_regclass('costing_read.approval_repair_request') IS NOT NULL THEN
        CREATE TRIGGER costing_purchase_repair_scope
          BEFORE INSERT OR UPDATE OF corp_id,expected_process_code ON costing_read.approval_repair_request
          FOR EACH ROW EXECUTE FUNCTION costing_read.enforce_purchase_repair_scope();
      END IF;
    END $repair$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $actor$ BEGIN
      IF to_regclass('costing_read.approval_actor_names_v1') IS NOT NULL THEN
        EXECUTE $view$
    CREATE OR REPLACE VIEW costing_read.approval_actor_names_v1
    WITH (security_barrier = true) AS
    WITH actor_refs AS (
      SELECT i.corp_id, i.originator_user_id AS user_id
        FROM public.ding_approval_instance i
        JOIN costing_read.allowed_process_template w USING (process_code)
       WHERE i.deleted_at IS NULL
         AND NULLIF(BTRIM(i.originator_user_id), '') IS NOT NULL
      UNION
      SELECT i.corp_id,
             COALESCE(
               operation->>'userId',
               operation->>'user_id',
               operation->>'operatorUserId'
             ) AS user_id
        FROM public.ding_approval_instance i
        JOIN costing_read.allowed_process_template w USING (process_code)
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE
           WHEN jsonb_typeof(COALESCE(
             i.raw_payload->'operationRecords',
             i.raw_payload->'operation_records',
             i.raw_payload->'comments'
           )) = 'array'
           THEN COALESCE(
             i.raw_payload->'operationRecords',
             i.raw_payload->'operation_records',
             i.raw_payload->'comments'
           )
           ELSE '[]'::jsonb
         END
       ) operation
       WHERE i.deleted_at IS NULL
         AND NULLIF(BTRIM(COALESCE(
           operation->>'userId',
           operation->>'user_id',
           operation->>'operatorUserId'
         )), '') IS NOT NULL
      UNION
      SELECT a.corp_id, a.comment_user_id AS user_id
        FROM costing_read.attachment_archive a
        JOIN costing_read.allowed_process_template w USING (process_code)
       WHERE NULLIF(BTRIM(a.comment_user_id), '') IS NOT NULL
    ), ranked_names AS (
      SELECT refs.corp_id::text AS corp_id,
             refs.user_id::text AS user_id,
             u.name::text AS name,
             u.title::text AS title,
             u.valid_from,
             u.valid_to,
             u.is_current,
             ROW_NUMBER() OVER (
               PARTITION BY refs.corp_id, refs.user_id
               ORDER BY u.is_current DESC, u.valid_from DESC, u.updated_at DESC, u.id DESC
             ) AS preference
        FROM actor_refs refs
        JOIN public.ding_user_snapshot u
          ON u.corp_id = refs.corp_id
         AND u.user_id = refs.user_id
       WHERE u.fetch_status = 'success'
         AND NULLIF(BTRIM(u.name), '') IS NOT NULL
         AND LOWER(BTRIM(u.name)) <> 'unknown'
    )
    SELECT corp_id, user_id, name, title, valid_from, valid_to, is_current
      FROM ranked_names
     WHERE preference = 1;

        $view$;
      END IF;
    END $actor$;

    DO $repair$ BEGIN
      IF to_regclass('costing_read.approval_repair_request') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS costing_purchase_repair_scope ON costing_read.approval_repair_request;
      END IF;
    END $repair$;
    DROP FUNCTION IF EXISTS costing_read.enforce_purchase_repair_scope();

    DROP TRIGGER costing_register_purchase_template ON public.ding_process_template;
    DROP FUNCTION costing_read.register_purchase_template();
    CREATE OR REPLACE FUNCTION costing_read.is_logistics_purchase(components jsonb)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
    DECLARE
      parent_names text[] := ARRAY[
        '采购类型', '采购类别', '采购分类', '采购支出',
        'tipodecompra', 'categoríadecompra', 'categoriadecompra', 'gastosdecompra',
        '采购类型tipodecompra', '采购类别categoríadecompra', '采购类别categoriadecompra',
        '采购分类categoríadecompra', '采购分类categoriadecompra', '采购支出gastosdecompra'
      ];
      child_names text[] := ARRAY[
        '服务类采购', 'adquisicionesdeservicios', 'compradeservicios',
        '服务类采购adquisicionesdeservicios', '服务类采购compradeservicios'
      ];
      service_values text[] := ARRAY['服务类采购', 'compradeservicios', '服务类采购compradeservicios'];
      logistics_values text[] := ARRAY[
        '物流及运输服务', 'serviciosdelogísticaytransporte', 'serviciosdelogisticaytransporte',
        '物流及运输服务serviciosdelogísticaytransporte', '物流及运输服务serviciosdelogisticaytransporte'
      ];
      commodity_values text[] := ARRAY[
        '商品类采购', '商品采购', 'comprademercancías', 'comprademercancias', 'compradebienes',
        '商品类采购comprademercancías', '商品类采购comprademercancias', '商品类采购compradebienes'
      ];
      component jsonb;
      field_name text;
      field_value jsonb;
      value_text text;
      path text[];
      service_parent boolean := false;
      logistics_child boolean := false;
      complete_path boolean := false;
    BEGIN
      IF jsonb_typeof(components) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      FOR component IN SELECT value FROM jsonb_array_elements(components) LOOP
        field_name := lower(regexp_replace(COALESCE(component->>'name', ''), '[[:space:]]+', '', 'g'));
        IF NOT (field_name = ANY(parent_names) OR field_name = ANY(child_names)) THEN CONTINUE; END IF;
        field_value := component->'value';
        path := NULL;
        IF jsonb_typeof(field_value) = 'string' THEN
          value_text := btrim(field_value #>> '{}');
          IF left(value_text, 1) = '[' THEN
            BEGIN
              field_value := value_text::jsonb;
            EXCEPTION WHEN invalid_text_representation THEN RETURN false;
            END;
          ELSE
            path := regexp_split_to_array(
              lower(regexp_replace(value_text, '[[:space:]]+', '', 'g')), '(→|->|>|/|／)'
            );
          END IF;
        END IF;
        IF path IS NULL THEN
          IF jsonb_typeof(field_value) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
          IF EXISTS (SELECT 1 FROM jsonb_array_elements(field_value) v WHERE jsonb_typeof(v) <> 'string') THEN
            RETURN false;
          END IF;
          SELECT array_agg(lower(regexp_replace(value, '[[:space:]]+', '', 'g')) ORDER BY ordinal)
            INTO path FROM jsonb_array_elements_text(field_value) WITH ORDINALITY AS v(value, ordinal);
        END IF;
        IF COALESCE(cardinality(path), 0) NOT IN (1, 2) THEN RETURN false; END IF;
        IF field_name = ANY(parent_names) THEN
          -- Any explicit commodity parent vetoes conflicting service paths elsewhere.
          IF path[1] = ANY(commodity_values) THEN RETURN false; END IF;
          IF NOT (path[1] = ANY(service_values)) THEN RETURN false; END IF;
          service_parent := true;
          IF cardinality(path) = 2 THEN
            IF NOT (path[2] = ANY(logistics_values)) THEN RETURN false; END IF;
            complete_path := true;
          END IF;
        ELSE
          IF cardinality(path) <> 1 OR NOT (path[1] = ANY(logistics_values)) THEN RETURN false; END IF;
          logistics_child := true;
        END IF;
      END LOOP;
      RETURN complete_path OR (service_parent AND logistics_child);
    END
    $fn$;


    CREATE OR REPLACE VIEW costing_read.approval_instances_v1 AS
    SELECT i.corp_id, i.process_instance_id,
      COALESCE(i.raw_payload->>'businessId', i.raw_payload->>'business_id') AS business_id,
      i.process_code, i.title, i.status, i.result,
      i.originator_user_id, i.originator_user_name, i.originator_dept_id, i.originator_dept_name,
      i.create_time, i.finish_time, i.form_component_values, i.raw_payload, i.last_event_time, i.updated_at
    FROM public.ding_approval_instance i
    JOIN costing_read.allowed_process_template w USING (process_code)
    WHERE i.deleted_at IS NULL;
    CREATE OR REPLACE VIEW costing_read.approval_instances_v2 AS
    SELECT i.corp_id, i.process_instance_id,
      COALESCE(i.raw_payload->>'businessId', i.raw_payload->>'business_id') AS business_id,
      i.process_code, i.title, i.status, i.result,
      i.originator_user_id, i.originator_user_name, i.originator_dept_id, i.originator_dept_name,
      i.create_time, i.finish_time, i.form_component_values, i.raw_payload,
      i.last_event_time, i.updated_at, i.deleted_at
    FROM public.ding_approval_instance i
    JOIN costing_read.allowed_process_template w USING (process_code);

    CREATE OR REPLACE VIEW costing_read.eligible_attachment_instances AS
    SELECT i.* FROM public.ding_approval_instance i
    JOIN costing_read.allowed_process_template w USING (process_code)
    WHERE i.deleted_at IS NULL AND (
      (w.purpose = 'international_logistics' AND w.archive_attachments)
      OR (w.purpose = 'purchase_expense' AND costing_read.is_logistics_purchase(
        COALESCE(i.form_component_values, i.raw_payload->'formComponentValues', i.raw_payload->'form_component_values')
      ))
    );

    CREATE OR REPLACE VIEW costing_read.attachment_archives_v2 AS
    SELECT a.corp_id, a.process_instance_id, a.process_code, a.attachment_origin,
      a.file_id, a.space_id, a.file_name, a.declared_size, a.bucket, a.object_key,
      a.actual_size, a.content_type, a.etag, a.sha256, a.archive_status, a.attempts,
      a.last_error, a.comment_user_id, a.comment_user_name, a.comment_time,
      a.comment_remark, a.archived_at, a.updated_at, a.archive_method,
      a.content_quality, a.failure_code, a.last_attempt_strategy, a.diagnostic_json,
      a.recovery_canary, a.retired_at
    FROM costing_read.attachment_archive a
    JOIN costing_read.allowed_process_template w USING (process_code);


    DROP FUNCTION costing_read.purchase_category_path(jsonb);
    DROP TABLE costing_read.purchase_approval_exposure;
    DROP TABLE costing_read.purchase_template_scope;
    -- A repair-request FK can intentionally block rollback. The whole migration is transactional;
    -- resolve those dependencies explicitly or roll forward, never delete repair evidence here.
    DELETE FROM costing_read.allowed_process_template WHERE auto_registered_purchase;
    ALTER TABLE costing_read.allowed_process_template DROP COLUMN auto_registered_purchase;
  `);
};
