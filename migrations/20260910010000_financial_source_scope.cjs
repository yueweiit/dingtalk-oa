/** Additive, repeatable financial discovery and durable historical coverage. No remote I/O. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS costing_read.financial_template_scope (
      corp_id varchar(64) NOT NULL, process_code varchar(128) NOT NULL,
      template_name text NOT NULL, registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (corp_id,process_code)
    );
    CREATE TABLE IF NOT EXISTS costing_read.financial_source_exposure (
      corp_id varchar(64) NOT NULL, process_instance_id varchar(128) NOT NULL,
      exposed_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (corp_id,process_instance_id)
    );
    CREATE TABLE IF NOT EXISTS costing_read.financial_template_discovery (
      corp_id varchar(64) NOT NULL, template_name text NOT NULL,
      process_code varchar(128), status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','failed')),
      attempts integer NOT NULL DEFAULT 0, last_checked_at timestamptz, last_error text,
      PRIMARY KEY(corp_id,template_name)
    );
    CREATE TABLE IF NOT EXISTS costing_read.financial_backfill_window (
      corp_id varchar(64) NOT NULL, process_code varchar(128) NOT NULL,
      window_start timestamptz NOT NULL, window_end timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
      next_token jsonb, pending_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      page_loaded boolean NOT NULL DEFAULT false,
      discovered_count bigint NOT NULL DEFAULT 0, processed_count bigint NOT NULL DEFAULT 0,
      lease_until timestamptz, lease_generation bigint NOT NULL DEFAULT 0,
      last_error text, completed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(corp_id,process_code,window_start,window_end), CHECK(window_start < window_end)
    );
    CREATE INDEX IF NOT EXISTS financial_backfill_rotation ON costing_read.financial_backfill_window(status,updated_at);

    CREATE OR REPLACE FUNCTION costing_read.is_financial_template(template_name text)
    RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $fn$
      SELECT COALESCE(template_name,'') ~* '(采购|支出|费用|报销|付款|支付|请款|结算|月结|gastos|compra|pago|reembolso|expense|payment|purchase|[- _]bu$)'
    $fn$;

    -- Read values, comment remarks and document names, never empty form labels or opaque IDs.
    CREATE OR REPLACE FUNCTION costing_read.financial_evidence_text(value jsonb)
    RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $fn$
    DECLARE item jsonb; entry record; result text := ''; scalar text;
    BEGIN
      IF value IS NULL OR value='null'::jsonb THEN RETURN ''; END IF;
      IF jsonb_typeof(value)='string' THEN
        scalar := value #>> '{}';
        IF left(btrim(scalar),1) IN ('[','{') THEN
          BEGIN RETURN costing_read.financial_evidence_text(scalar::jsonb);
          EXCEPTION WHEN invalid_text_representation THEN NULL; END;
        END IF;
        RETURN scalar;
      ELSIF jsonb_typeof(value)='array' THEN
        FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
          result := result || ' ' || costing_read.financial_evidence_text(item);
        END LOOP;
      ELSIF jsonb_typeof(value)='object' THEN
        -- A populated fee field carries meaning in its label; an empty label remains no evidence.
        IF value->>'name' ~* '(运费|运输费|海运|空运|头程|干线|燃油附加|运输附加|港杂|滞箱|滞港|压车|freight|flete|surcharge|demurrage|detention|关税|税费|清关|报关|尾程|末端|customs|duties|tax|last[ -]mile)'
          AND costing_read.financial_evidence_text(value->'value') ~ '[1-9]' THEN
          result := value->>'name';
        END IF;
        FOR entry IN SELECT * FROM jsonb_each(value) LOOP
          -- Selected categories are separate evidence, never proof of a charged freight amount.
          IF entry.key='value' AND value->>'name' ~* '(采购分类|采购类别|采购类型|服务类采购|付款分类|费用类型|费用分类|费用类别|支出分类|支出类别|支付分类|expense.?category)' THEN
            CONTINUE;
          END IF;
          IF entry.key IN ('value','remark','comment','text','content','fileName','file_name','filename','files','attachments','operationAttachments','operationRecords','operation_records','comments','formComponentValues','form_component_values') THEN
            result := result || ' ' || costing_read.financial_evidence_text(entry.value);
          END IF;
        END LOOP;
      ELSE RETURN value::text;
      END IF;
      RETURN btrim(result);
    END $fn$;

    CREATE OR REPLACE FUNCTION costing_read.financial_attachment_ids(value jsonb)
    RETURNS text[] LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $fn$
    DECLARE item jsonb; entry record; ids text[] := ARRAY[]::text[]; scalar text; id text;
    BEGIN
      IF jsonb_typeof(value)='string' THEN
        scalar := value #>> '{}';
        IF left(btrim(scalar),1) IN ('[','{') THEN
          BEGIN RETURN costing_read.financial_attachment_ids(scalar::jsonb);
          EXCEPTION WHEN invalid_text_representation THEN NULL; END;
        END IF;
      ELSIF jsonb_typeof(value)='array' THEN
        FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
          ids := ids || costing_read.financial_attachment_ids(item);
        END LOOP;
      ELSIF jsonb_typeof(value)='object' THEN
        id := COALESCE(NULLIF(value->>'fileId',''),NULLIF(value->>'file_id',''),NULLIF(value->>'fileID',''),NULLIF(value->>'mediaId',''),NULLIF(value->>'media_id',''));
        IF NULLIF(btrim(id),'') IS NOT NULL THEN ids := array_append(ids,btrim(id)); END IF;
        FOR entry IN SELECT * FROM jsonb_each(value) LOOP
          IF entry.key <> 'thumbnail' THEN ids := ids || costing_read.financial_attachment_ids(entry.value); END IF;
        END LOOP;
      END IF;
      RETURN ids;
    END $fn$;

    CREATE OR REPLACE FUNCTION costing_read.financial_field_items(value jsonb)
    RETURNS SETOF jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $fn$
    DECLARE item jsonb; scalar text;
    BEGIN
      IF jsonb_typeof(value)='string' THEN
        scalar := value #>> '{}';
        IF left(btrim(scalar),1) IN ('[','{') THEN
          BEGIN RETURN QUERY SELECT * FROM costing_read.financial_field_items(scalar::jsonb);
          EXCEPTION WHEN invalid_text_representation THEN NULL; END;
        END IF;
      ELSIF jsonb_typeof(value)='array' THEN
        FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
          RETURN QUERY SELECT * FROM costing_read.financial_field_items(item);
        END LOOP;
      ELSIF jsonb_typeof(value)='object' THEN
        IF value ? 'name' AND value ? 'value' THEN RETURN NEXT value; END IF;
        FOR item IN SELECT v FROM jsonb_each(value) AS e(k,v) LOOP
          RETURN QUERY SELECT * FROM costing_read.financial_field_items(item);
        END LOOP;
      END IF;
      RETURN;
    END $fn$;

    CREATE OR REPLACE FUNCTION costing_read.has_financial_fields(components jsonb)
    RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $fn$
      SELECT EXISTS (SELECT 1 FROM costing_read.financial_field_items(components) f
        WHERE f->>'name' ~* '(金额|应付|实付|付款|支付|报销|费|支出|amount|importe|monto|pago|cost)'
        AND costing_read.financial_evidence_text(f->'value') ~ '[0-9]')
    $fn$;

    CREATE OR REPLACE FUNCTION costing_read.financial_excluded_charge_only(title text,components jsonb,payload jsonb)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $fn$
    DECLARE body text; included_body text;
    BEGIN
      body := lower(COALESCE(title,'') || ' ' || costing_read.financial_evidence_text(components) || ' ' || costing_read.financial_evidence_text(payload));
      IF body !~ '(关税|税费|清关|报关|尾程|末端|最后一公里|customs|duties|tax|last[ -]mile)' THEN RETURN false; END IF;
      included_body := regexp_replace(body,'(尾程|末端|最后一公里|last[ -]mile)[^,，;；。及与和+]{0,12}(运费|运输费|freight|delivery)','', 'gi');
      RETURN included_body !~ '(海运费|空运费|头程运|头程费|干线运|运费|运输费用|运输费|flete|ocean freight|air freight|international freight|linehaul|燃油附加|运输附加|港杂|滞箱|滞港|压车|集装箱超期|demurrage|detention|fuel surcharge|bunker adjustment|recargo de combustible)';
    END $fn$;

    CREATE OR REPLACE FUNCTION costing_read.financial_transport_evidence(title text, components jsonb, payload jsonb)
    RETURNS text[] LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $fn$
    DECLARE evidence text[] := ARRAY[]::text[]; body text; main_body text;
    BEGIN
      body := lower(COALESCE(title,'') || ' ' || costing_read.financial_evidence_text(components) || ' ' || costing_read.financial_evidence_text(payload));
      -- Explicit out-of-scope prefixes must not turn generic 运费 into main-freight evidence.
      main_body := regexp_replace(body,'(尾程|末端|最后一公里|last[ -]mile)[^,，;；。及与和+]{0,12}(运费|运输费|freight|delivery)','', 'gi');
      IF costing_read.is_logistics_purchase(components) OR EXISTS (
        SELECT 1 FROM costing_read.financial_field_items(components) f
        WHERE f->>'name' ~* '(付款分类|费用类型|费用分类|费用类别|支出分类|支出类别|支付分类|expense.?category)'
          AND lower(regexp_replace(costing_read.financial_evidence_text(f->'value'),'[[:space:]]+','','g'))
            IN ('物流费用','物流费','运输费用','运输服务','物流及运输服务','freight','logistics','transport','gastosdelogística','gastosdelogistica')
      ) THEN evidence := array_append(evidence,'logistics_category'); END IF;
      IF main_body ~ '(海运|空运|头程|干线|国际物流|国际运输|运费|运输费用|运输费|flete|ocean freight|air freight|international freight|linehaul)'
        AND NOT costing_read.financial_excluded_charge_only(title,components,payload) THEN
        evidence := array_append(evidence,'main_freight');
      END IF;
      IF body ~ '(燃油附加|运输附加|港杂|滞箱|滞港|压车|集装箱超期|demurrage|detention|fuel surcharge|bunker adjustment|recargo de combustible)' THEN
        evidence := array_append(evidence,'transport_surcharge');
      END IF;
      IF EXISTS (SELECT 1 FROM costing_read.financial_field_items(components) f
        WHERE f->>'name' ~* '(提单|柜号|集装箱号|运单|运输单|物流审批|国际物流|bill of lading|waybill|container number)'
          AND NULLIF(btrim(costing_read.financial_evidence_text(f->'value')),'') IS NOT NULL)
        OR body ~ '(提单号|运单号|柜号|bill of lading|waybill|运单[. _-]|提单[. _-])' THEN
        evidence := array_append(evidence,'logistics_reference');
      END IF;
      RETURN evidence;
    END $fn$;

    CREATE OR REPLACE FUNCTION costing_read.has_known_logistics_reference(corporation text,components jsonb)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
      SELECT EXISTS (
        SELECT 1 FROM costing_read.financial_field_items(components) f
        CROSS JOIN LATERAL regexp_split_to_table(COALESCE(f->'value','null'::jsonb)::text,'[^a-zA-Z0-9_-]+') token
        JOIN public.ding_approval_instance l ON l.corp_id=corporation AND l.process_instance_id=token
        JOIN costing_read.allowed_process_template w ON w.process_code=l.process_code
        WHERE (COALESCE(f->>'componentType',f->>'component_type','')='RelateField' OR f->>'name' ~ '(关联.*审批|关联.*物流|审批引用)')
          AND w.purpose='international_logistics'
          AND (NOT w.auto_registered_purchase OR EXISTS(SELECT 1 FROM costing_read.purchase_template_scope ps
            WHERE ps.corp_id=l.corp_id AND ps.process_code=l.process_code))
      )
    $fn$;

    CREATE OR REPLACE FUNCTION costing_read.financial_source_valid(status text,result text,deleted_at timestamptz)
    RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $fn$
      SELECT deleted_at IS NULL AND upper(COALESCE(status,'')) NOT IN
        ('TERMINATED','CANCELED','CANCELLED','DELETED','REJECTED','WITHDRAWN','WITHDRAW','REVOKED','撤销','已撤销','驳回')
        AND lower(COALESCE(result,'')) NOT IN ('refuse','reject','rejected','disagree','撤销','驳回')
    $fn$;

    CREATE OR REPLACE FUNCTION costing_read.register_financial_template()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
    BEGIN
      IF costing_read.is_financial_template(NEW.name) THEN
        INSERT INTO costing_read.financial_template_scope(corp_id,process_code,template_name)
          VALUES(NEW.corp_id,NEW.process_code,NEW.name) ON CONFLICT(corp_id,process_code) DO NOTHING;
        INSERT INTO costing_read.allowed_process_template(process_code,purpose,archive_attachments,auto_registered_purchase)
          VALUES(NEW.process_code,'purchase_expense',false,true) ON CONFLICT(process_code) DO NOTHING;
        INSERT INTO costing_read.purchase_template_scope(corp_id,process_code)
          VALUES(NEW.corp_id,NEW.process_code) ON CONFLICT(corp_id,process_code) DO NOTHING;
      END IF;
      RETURN NEW;
    END $fn$;
    DROP TRIGGER IF EXISTS costing_register_financial_template ON public.ding_process_template;
    CREATE TRIGGER costing_register_financial_template AFTER INSERT OR UPDATE OF name,corp_id,process_code
      ON public.ding_process_template FOR EACH ROW EXECUTE FUNCTION costing_read.register_financial_template();
    INSERT INTO costing_read.financial_template_scope(corp_id,process_code,template_name)
      SELECT corp_id,process_code,name FROM public.ding_process_template WHERE costing_read.is_financial_template(name)
      ON CONFLICT(corp_id,process_code) DO NOTHING;
    INSERT INTO costing_read.allowed_process_template(process_code,purpose,archive_attachments,auto_registered_purchase)
      SELECT DISTINCT process_code,'purchase_expense',false,true FROM costing_read.financial_template_scope
      ON CONFLICT(process_code) DO NOTHING;
    INSERT INTO costing_read.purchase_template_scope(corp_id,process_code)
      SELECT corp_id,process_code FROM costing_read.financial_template_scope ON CONFLICT(corp_id,process_code) DO NOTHING;

    CREATE OR REPLACE FUNCTION costing_read.expose_financial_source()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
    DECLARE components jsonb;
    BEGIN
      components := COALESCE(NEW.form_component_values,NEW.raw_payload->'formComponentValues',NEW.raw_payload->'form_component_values');
      IF costing_read.has_financial_fields(components)
        AND (cardinality(costing_read.financial_transport_evidence(NEW.title,components,NEW.raw_payload)) > 0
          OR costing_read.has_known_logistics_reference(NEW.corp_id,components)) THEN
        INSERT INTO costing_read.financial_source_exposure(corp_id,process_instance_id)
          VALUES(NEW.corp_id,NEW.process_instance_id) ON CONFLICT(corp_id,process_instance_id) DO NOTHING;
      END IF;
      RETURN NEW;
    END $fn$;
    DROP TRIGGER IF EXISTS costing_expose_financial_source ON public.ding_approval_instance;
    CREATE TRIGGER costing_expose_financial_source AFTER INSERT OR UPDATE OF title,form_component_values,raw_payload
      ON public.ding_approval_instance FOR EACH ROW EXECUTE FUNCTION costing_read.expose_financial_source();
    INSERT INTO costing_read.financial_source_exposure(corp_id,process_instance_id)
      SELECT i.corp_id,i.process_instance_id FROM public.ding_approval_instance i
      LEFT JOIN costing_read.allowed_process_template w USING(process_code)
      WHERE (costing_read.has_financial_fields(COALESCE(i.form_component_values,i.raw_payload->'formComponentValues',i.raw_payload->'form_component_values'))
        OR (w.purpose='purchase_expense' AND (NOT w.auto_registered_purchase OR EXISTS(SELECT 1 FROM costing_read.purchase_template_scope ps WHERE ps.corp_id=i.corp_id AND ps.process_code=i.process_code))))
        AND (cardinality(costing_read.financial_transport_evidence(i.title,
          COALESCE(i.form_component_values,i.raw_payload->'formComponentValues',i.raw_payload->'form_component_values'),i.raw_payload)) > 0
          OR costing_read.has_known_logistics_reference(i.corp_id,COALESCE(i.form_component_values,i.raw_payload->'formComponentValues',i.raw_payload->'form_component_values')))
        AND NOT EXISTS (SELECT 1 FROM costing_read.eligible_attachment_instances previous
          WHERE previous.corp_id=i.corp_id AND previous.process_instance_id=i.process_instance_id)
      ON CONFLICT(corp_id,process_instance_id) DO NOTHING;

    CREATE OR REPLACE VIEW costing_read.approval_instances_v2 AS
    SELECT i.corp_id,i.process_instance_id,
      COALESCE(i.raw_payload->>'businessId',i.raw_payload->>'business_id') AS business_id,
      i.process_code,i.title,i.status,i.result,i.originator_user_id,i.originator_user_name,i.originator_dept_id,i.originator_dept_name,
      i.create_time,i.finish_time,i.form_component_values,i.raw_payload,i.last_event_time,
      GREATEST(i.updated_at,CASE WHEN w.auto_registered_purchase THEN s.registered_at END,e.exposed_at,
        f.registered_at,x.exposed_at) AS updated_at,i.deleted_at
    FROM public.ding_approval_instance i
    LEFT JOIN costing_read.allowed_process_template w USING(process_code)
    LEFT JOIN costing_read.purchase_template_scope s USING(corp_id,process_code)
    LEFT JOIN costing_read.purchase_approval_exposure e USING(corp_id,process_instance_id)
    LEFT JOIN costing_read.financial_template_scope f USING(corp_id,process_code)
    LEFT JOIN costing_read.financial_source_exposure x USING(corp_id,process_instance_id)
    WHERE (w.process_code IS NOT NULL AND (NOT w.auto_registered_purchase OR s.process_code IS NOT NULL))
      OR f.process_code IS NOT NULL OR x.process_instance_id IS NOT NULL;

    CREATE OR REPLACE VIEW costing_read.financial_sources_v1 AS
    SELECT i.*,COALESCE(t.name,f.template_name) AS template_name,
      'financial'::text AS source_kind,
      COALESCE(f.registered_at,x.exposed_at) AS scope_registered_at,
      ev.evidence AS transport_evidence,
      cardinality(ev.evidence)>0 AS has_transport_evidence,
      costing_read.financial_source_valid(COALESCE(i.status,i.raw_payload->>'status'),COALESCE(i.result,i.raw_payload->>'result'),i.deleted_at) AS source_valid,
      (cardinality(ev.evidence)>0
        AND NOT costing_read.financial_excluded_charge_only(i.title,
          COALESCE(i.form_component_values,i.raw_payload->'formComponentValues',i.raw_payload->'form_component_values'),i.raw_payload)
        AND upper(COALESCE(i.status,i.raw_payload->>'status','')) IN ('COMPLETED','FINISHED','APPROVED')
        AND costing_read.financial_source_valid(COALESCE(i.status,i.raw_payload->>'status'),COALESCE(i.result,i.raw_payload->>'result'),i.deleted_at)) AS eligible_for_adoption,
      COALESCE(a.attachment_count,0::bigint) AS attachment_count,
      COALESCE(a.available_count,0::bigint) AS attachment_available_count,
      COALESCE(a.pending_count,0::bigint) AS attachment_pending_count,
      COALESCE(a.failed_count,0::bigint) AS attachment_failed_count,
      COALESCE(a.retired_count,0::bigint) AS attachment_retired_count,
      GREATEST(i.updated_at,a.updated_at) AS evidence_updated_at,
      refs.reference_count AS attachment_reference_count,
      GREATEST(refs.reference_count-COALESCE(a.attachment_count,0::bigint),0::bigint) AS attachment_unqueued_count
    FROM costing_read.approval_instances_v2 i
    LEFT JOIN public.ding_process_template t USING(corp_id,process_code)
    LEFT JOIN costing_read.financial_template_scope f USING(corp_id,process_code)
    LEFT JOIN costing_read.financial_source_exposure x USING(corp_id,process_instance_id)
    LEFT JOIN costing_read.allowed_process_template w USING(process_code)
    CROSS JOIN LATERAL (SELECT ARRAY(SELECT DISTINCT reason FROM unnest(
      costing_read.financial_transport_evidence(i.title,
        COALESCE(i.form_component_values,i.raw_payload->'formComponentValues',i.raw_payload->'form_component_values'),i.raw_payload)
      || CASE WHEN costing_read.has_known_logistics_reference(i.corp_id,
        COALESCE(i.form_component_values,i.raw_payload->'formComponentValues',i.raw_payload->'form_component_values'))
        THEN ARRAY['logistics_reference']::text[] ELSE ARRAY[]::text[] END) reason ORDER BY reason) AS evidence) ev
    CROSS JOIN LATERAL (SELECT count(DISTINCT id) AS reference_count FROM unnest(
      costing_read.financial_attachment_ids(jsonb_build_object('formComponentValues',
        COALESCE(i.form_component_values,i.raw_payload->'formComponentValues',i.raw_payload->'form_component_values'),
        'operationRecords',COALESCE(i.raw_payload->'operationRecords',i.raw_payload->'operation_records',i.raw_payload->'comments')))) id) refs
    LEFT JOIN LATERAL (SELECT count(*) FILTER(WHERE retired_at IS NULL) AS attachment_count,
      count(*) FILTER(WHERE retired_at IS NULL AND archive_status='archived') AS available_count,
      count(*) FILTER(WHERE retired_at IS NULL AND archive_status IN ('pending','archiving','retry')) AS pending_count,
      count(*) FILTER(WHERE retired_at IS NULL AND archive_status='manual_required') AS failed_count,
      count(*) FILTER(WHERE retired_at IS NOT NULL) AS retired_count,max(updated_at) AS updated_at
      FROM costing_read.attachment_archive a WHERE a.corp_id=i.corp_id AND a.process_instance_id=i.process_instance_id) a ON true
    WHERE f.process_code IS NOT NULL OR x.process_instance_id IS NOT NULL OR w.purpose='purchase_expense';

    CREATE OR REPLACE VIEW costing_read.eligible_attachment_instances AS
    SELECT i.* FROM public.ding_approval_instance i
    WHERE i.deleted_at IS NULL AND (
      EXISTS(SELECT 1 FROM costing_read.allowed_process_template w WHERE w.process_code=i.process_code
        AND w.purpose='international_logistics' AND w.archive_attachments
        AND (NOT w.auto_registered_purchase OR EXISTS(SELECT 1 FROM costing_read.purchase_template_scope s
          WHERE s.corp_id=i.corp_id AND s.process_code=i.process_code)))
      OR EXISTS(SELECT 1 FROM costing_read.financial_sources_v1 f WHERE f.corp_id=i.corp_id
        AND f.process_instance_id=i.process_instance_id AND f.source_valid AND f.has_transport_evidence)
    );

    CREATE OR REPLACE VIEW costing_read.attachment_archives_v2 AS
    SELECT a.corp_id,a.process_instance_id,a.process_code,a.attachment_origin,a.file_id,a.space_id,a.file_name,a.declared_size,
      a.bucket,a.object_key,a.actual_size,a.content_type,a.etag,a.sha256,a.archive_status,a.attempts,a.last_error,
      a.comment_user_id,a.comment_user_name,a.comment_time,a.comment_remark,a.archived_at,a.updated_at,a.archive_method,
      a.content_quality,a.failure_code,a.last_attempt_strategy,a.diagnostic_json,a.recovery_canary,a.retired_at
    FROM costing_read.attachment_archive a
    JOIN costing_read.approval_instances_v2 i USING(corp_id,process_instance_id);

    CREATE OR REPLACE VIEW costing_read.completed_refresh_instances AS
    SELECT i.* FROM public.ding_approval_instance i
    WHERE upper(COALESCE(i.status,''))='COMPLETED' AND i.deleted_at IS NULL AND (
      EXISTS(SELECT 1 FROM costing_read.eligible_attachment_instances e WHERE e.corp_id=i.corp_id AND e.process_instance_id=i.process_instance_id)
      OR EXISTS(SELECT 1 FROM costing_read.financial_sources_v1 f WHERE f.corp_id=i.corp_id AND f.process_instance_id=i.process_instance_id AND f.source_valid)
    );

    CREATE OR REPLACE VIEW costing_read.financial_template_coverage_v1 AS
    SELECT f.corp_id,f.process_code,f.template_name,f.registered_at,
      w.window_start,w.window_end,COALESCE(w.status,'not_scheduled') AS status,
      w.discovered_count,w.processed_count,jsonb_array_length(w.pending_ids) AS pending_instance_count,
      w.last_error,w.completed_at,w.updated_at,
      (SELECT count(*) FROM costing_read.financial_sources_v1 i WHERE i.corp_id=f.corp_id AND i.process_code=f.process_code) AS source_count,
      (SELECT count(*) FROM costing_read.financial_sources_v1 i WHERE i.corp_id=f.corp_id AND i.process_code=f.process_code AND i.eligible_for_adoption) AS eligible_source_count,
      (SELECT COALESCE(sum(i.attachment_count),0)::bigint FROM costing_read.financial_sources_v1 i WHERE i.corp_id=f.corp_id AND i.process_code=f.process_code) AS attachment_count,
      (SELECT COALESCE(sum(i.attachment_available_count),0)::bigint FROM costing_read.financial_sources_v1 i WHERE i.corp_id=f.corp_id AND i.process_code=f.process_code) AS attachment_available_count
    FROM costing_read.financial_template_scope f
    LEFT JOIN costing_read.financial_backfill_window w USING(corp_id,process_code);

    CREATE OR REPLACE VIEW costing_read.financial_template_discovery_v1 AS
      SELECT corp_id,template_name,process_code,status,attempts,last_checked_at,last_error
      FROM costing_read.financial_template_discovery;

    REVOKE ALL ON TABLE costing_read.financial_template_scope,costing_read.financial_source_exposure,
      costing_read.financial_template_discovery,costing_read.financial_backfill_window FROM PUBLIC;
    REVOKE ALL ON FUNCTION costing_read.register_financial_template(),costing_read.expose_financial_source() FROM PUBLIC;
    DO $grant$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='costing_reader') THEN
        GRANT SELECT ON costing_read.financial_sources_v1,costing_read.financial_template_coverage_v1,
          costing_read.financial_template_discovery_v1 TO costing_reader;
      END IF;
    END $grant$;
  `);
};

// Scope ledgers are durable audit evidence; use the documented application rollback and roll forward.
exports.down = () => { throw new Error('Financial scope rollback would discard durable coverage and exposure evidence; retain this additive migration and roll back application code only.'); };
