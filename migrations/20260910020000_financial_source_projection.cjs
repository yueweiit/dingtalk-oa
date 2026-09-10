/** Parse immutable snapshot evidence on write, keeping finance reads independent of JSON size. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS costing_read.financial_source_projection (
      corp_id varchar(64) NOT NULL, process_instance_id varchar(128) NOT NULL,
      transport_evidence text[] NOT NULL, excluded_charge_only boolean NOT NULL,
      has_financial_fields boolean NOT NULL, related_instance_ids text[] NOT NULL,
      attachment_reference_count bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(corp_id,process_instance_id),
      FOREIGN KEY(corp_id,process_instance_id) REFERENCES public.ding_approval_instance(corp_id,process_instance_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS financial_projection_related_ids ON costing_read.financial_source_projection USING gin(related_instance_ids);

    CREATE OR REPLACE FUNCTION costing_read.financial_related_instance_ids(components jsonb)
    RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $fn$
      SELECT ARRAY(SELECT DISTINCT token FROM costing_read.financial_field_items(components) f
        CROSS JOIN LATERAL regexp_split_to_table(COALESCE(f->'value','null'::jsonb)::text,'[^a-zA-Z0-9_-]+') token
        WHERE token<>'' AND (COALESCE(f->>'componentType',f->>'component_type','')='RelateField'
          OR f->>'name' ~ '(关联.*审批|关联.*物流|审批引用)') ORDER BY token)
    $fn$;

    CREATE OR REPLACE FUNCTION costing_read.has_projected_logistics_reference(corporation text,related_ids text[])
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
      SELECT EXISTS(SELECT 1 FROM unnest(related_ids) token
        JOIN public.ding_approval_instance l ON l.corp_id=corporation AND l.process_instance_id=token
        JOIN costing_read.allowed_process_template w ON w.process_code=l.process_code
        WHERE w.purpose='international_logistics' AND (NOT w.auto_registered_purchase OR EXISTS(
          SELECT 1 FROM costing_read.purchase_template_scope ps WHERE ps.corp_id=l.corp_id AND ps.process_code=l.process_code)))
    $fn$;

    CREATE OR REPLACE FUNCTION costing_read.refresh_financial_reference_dependents(corporation text,instance_id text)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
    BEGIN
      -- A related logistics snapshot can arrive after its payment. Surface its evidence incrementally.
      UPDATE costing_read.financial_source_projection SET updated_at=clock_timestamp()
        WHERE corp_id=corporation AND related_instance_ids @> ARRAY[instance_id];
      INSERT INTO costing_read.financial_source_exposure(corp_id,process_instance_id)
        SELECT corp_id,process_instance_id FROM costing_read.financial_source_projection p
        WHERE p.corp_id=corporation AND p.related_instance_ids @> ARRAY[instance_id]
          AND p.has_financial_fields AND costing_read.has_projected_logistics_reference(p.corp_id,p.related_instance_ids)
        ON CONFLICT(corp_id,process_instance_id) DO NOTHING;
    END $fn$;

    CREATE OR REPLACE FUNCTION costing_read.expose_financial_source()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
    DECLARE components jsonb; evidence text[]; related_ids text[]; financial boolean; lock_id text;
    BEGIN
      components := COALESCE(NEW.form_component_values,NEW.raw_payload->'formComponentValues',NEW.raw_payload->'form_component_values');
      evidence := costing_read.financial_transport_evidence(NEW.title,components,NEW.raw_payload);
      related_ids := costing_read.financial_related_instance_ids(components);
      financial := costing_read.has_financial_fields(components);
      -- Serialize each source and its referenced IDs before either side checks visibility.
      -- The archive writers use READ COMMITTED; SQL statements after a waiter resumes see its peer's commit.
      FOR lock_id IN SELECT DISTINCT id FROM unnest(related_ids || ARRAY[NEW.process_instance_id::text]) id ORDER BY id LOOP
        PERFORM pg_advisory_xact_lock(hashtext(NEW.corp_id),hashtext(lock_id));
      END LOOP;
      INSERT INTO costing_read.financial_source_projection(corp_id,process_instance_id,transport_evidence,
        excluded_charge_only,has_financial_fields,related_instance_ids,attachment_reference_count)
      VALUES(NEW.corp_id,NEW.process_instance_id,evidence,
        costing_read.financial_excluded_charge_only(NEW.title,components,NEW.raw_payload),financial,related_ids,
        (SELECT count(DISTINCT id) FROM unnest(costing_read.financial_attachment_ids(jsonb_build_object(
          'formComponentValues',components,'operationRecords',COALESCE(NEW.raw_payload->'operationRecords',
            NEW.raw_payload->'operation_records',NEW.raw_payload->'comments')))) id))
      ON CONFLICT(corp_id,process_instance_id) DO UPDATE SET transport_evidence=EXCLUDED.transport_evidence,
        excluded_charge_only=EXCLUDED.excluded_charge_only,has_financial_fields=EXCLUDED.has_financial_fields,
        related_instance_ids=EXCLUDED.related_instance_ids,attachment_reference_count=EXCLUDED.attachment_reference_count,
        updated_at=clock_timestamp()
      WHERE (financial_source_projection.transport_evidence,financial_source_projection.excluded_charge_only,
        financial_source_projection.has_financial_fields,financial_source_projection.related_instance_ids,
        financial_source_projection.attachment_reference_count) IS DISTINCT FROM
        (EXCLUDED.transport_evidence,EXCLUDED.excluded_charge_only,EXCLUDED.has_financial_fields,
          EXCLUDED.related_instance_ids,EXCLUDED.attachment_reference_count);
      IF financial AND (cardinality(evidence)>0 OR costing_read.has_projected_logistics_reference(NEW.corp_id,related_ids)) THEN
        INSERT INTO costing_read.financial_source_exposure(corp_id,process_instance_id)
          VALUES(NEW.corp_id,NEW.process_instance_id) ON CONFLICT(corp_id,process_instance_id) DO NOTHING;
      END IF;
      IF TG_OP='INSERT' OR OLD.process_code IS DISTINCT FROM NEW.process_code THEN
        PERFORM costing_read.refresh_financial_reference_dependents(NEW.corp_id,NEW.process_instance_id);
      END IF;
      RETURN NEW;
    END $fn$;
    DROP TRIGGER IF EXISTS costing_expose_financial_source ON public.ding_approval_instance;
    CREATE TRIGGER costing_expose_financial_source AFTER INSERT OR UPDATE OF process_code,title,form_component_values,raw_payload
      ON public.ding_approval_instance FOR EACH ROW EXECUTE FUNCTION costing_read.expose_financial_source();

    -- No snapshot mutation, API request or attachment download. Existing projections are preserved on replay.
    INSERT INTO costing_read.financial_source_projection(corp_id,process_instance_id,transport_evidence,
      excluded_charge_only,has_financial_fields,related_instance_ids,attachment_reference_count,updated_at)
    SELECT i.corp_id,i.process_instance_id,costing_read.financial_transport_evidence(i.title,c.components,i.raw_payload),
      costing_read.financial_excluded_charge_only(i.title,c.components,i.raw_payload),
      costing_read.has_financial_fields(c.components),costing_read.financial_related_instance_ids(c.components),
      (SELECT count(DISTINCT id) FROM unnest(costing_read.financial_attachment_ids(jsonb_build_object(
        'formComponentValues',c.components,'operationRecords',COALESCE(i.raw_payload->'operationRecords',
          i.raw_payload->'operation_records',i.raw_payload->'comments')))) id),i.updated_at
    FROM public.ding_approval_instance i
    CROSS JOIN LATERAL (SELECT COALESCE(i.form_component_values,i.raw_payload->'formComponentValues',i.raw_payload->'form_component_values') components) c
    WHERE NOT EXISTS(SELECT 1 FROM costing_read.financial_source_projection p
      WHERE p.corp_id=i.corp_id AND p.process_instance_id=i.process_instance_id)
    ON CONFLICT(corp_id,process_instance_id) DO NOTHING;
    INSERT INTO costing_read.financial_source_exposure(corp_id,process_instance_id)
      SELECT p.corp_id,p.process_instance_id FROM costing_read.financial_source_projection p
      WHERE p.has_financial_fields AND (cardinality(p.transport_evidence)>0
        OR costing_read.has_projected_logistics_reference(p.corp_id,p.related_instance_ids))
      ON CONFLICT(corp_id,process_instance_id) DO NOTHING;

    CREATE OR REPLACE FUNCTION costing_read.refresh_financial_reference_template()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
    DECLARE instance record;
    BEGIN
      FOR instance IN SELECT corp_id,process_instance_id FROM public.ding_approval_instance WHERE process_code=NEW.process_code LOOP
        PERFORM costing_read.refresh_financial_reference_dependents(instance.corp_id,instance.process_instance_id);
      END LOOP;
      RETURN NEW;
    END $fn$;
    DROP TRIGGER IF EXISTS financial_reference_template ON costing_read.allowed_process_template;
    CREATE TRIGGER financial_reference_template AFTER INSERT OR UPDATE OF purpose,auto_registered_purchase
      ON costing_read.allowed_process_template FOR EACH ROW EXECUTE FUNCTION costing_read.refresh_financial_reference_template();
    DROP TRIGGER IF EXISTS financial_reference_corporation_scope ON costing_read.purchase_template_scope;
    CREATE TRIGGER financial_reference_corporation_scope AFTER INSERT OR UPDATE OF corp_id,process_code
      ON costing_read.purchase_template_scope FOR EACH ROW EXECUTE FUNCTION costing_read.refresh_financial_reference_template();
    CREATE OR REPLACE VIEW costing_read.financial_sources_v1 AS
    SELECT i.*,COALESCE(t.name,f.template_name) AS template_name,
      'financial'::text AS source_kind,
      COALESCE(f.registered_at,x.exposed_at) AS scope_registered_at,
      ev.evidence AS transport_evidence,
      cardinality(ev.evidence)>0 AS has_transport_evidence,
      costing_read.financial_source_valid(COALESCE(i.status,i.raw_payload->>'status'),COALESCE(i.result,i.raw_payload->>'result'),i.deleted_at) AS source_valid,
      (cardinality(ev.evidence)>0
        AND NOT p.excluded_charge_only
        AND upper(COALESCE(i.status,i.raw_payload->>'status','')) IN ('COMPLETED','FINISHED','APPROVED')
        AND costing_read.financial_source_valid(COALESCE(i.status,i.raw_payload->>'status'),COALESCE(i.result,i.raw_payload->>'result'),i.deleted_at)) AS eligible_for_adoption,
      COALESCE(a.attachment_count,0::bigint) AS attachment_count,
      COALESCE(a.available_count,0::bigint) AS attachment_available_count,
      COALESCE(a.pending_count,0::bigint) AS attachment_pending_count,
      COALESCE(a.failed_count,0::bigint) AS attachment_failed_count,
      COALESCE(a.retired_count,0::bigint) AS attachment_retired_count,
      GREATEST(i.updated_at,a.updated_at,p.updated_at) AS evidence_updated_at,
      p.attachment_reference_count AS attachment_reference_count,
      GREATEST(p.attachment_reference_count-COALESCE(a.attachment_count,0::bigint),0::bigint) AS attachment_unqueued_count
    FROM costing_read.approval_instances_v2 i
    LEFT JOIN public.ding_process_template t USING(corp_id,process_code)
    LEFT JOIN costing_read.financial_template_scope f USING(corp_id,process_code)
    LEFT JOIN costing_read.financial_source_exposure x USING(corp_id,process_instance_id)
    LEFT JOIN costing_read.allowed_process_template w USING(process_code)
    JOIN costing_read.financial_source_projection p USING(corp_id,process_instance_id)
    CROSS JOIN LATERAL (SELECT ARRAY(SELECT DISTINCT reason FROM unnest(p.transport_evidence
      || CASE WHEN costing_read.has_projected_logistics_reference(i.corp_id,p.related_instance_ids)
        THEN ARRAY['logistics_reference']::text[] ELSE ARRAY[]::text[] END) reason ORDER BY reason) AS evidence) ev
    LEFT JOIN LATERAL (SELECT count(*) FILTER(WHERE retired_at IS NULL) AS attachment_count,
      count(*) FILTER(WHERE retired_at IS NULL AND archive_status='archived') AS available_count,
      count(*) FILTER(WHERE retired_at IS NULL AND archive_status IN ('pending','archiving','retry')) AS pending_count,
      count(*) FILTER(WHERE retired_at IS NULL AND archive_status='manual_required') AS failed_count,
      count(*) FILTER(WHERE retired_at IS NOT NULL) AS retired_count,max(updated_at) AS updated_at
      FROM costing_read.attachment_archive a WHERE a.corp_id=i.corp_id AND a.process_instance_id=i.process_instance_id) a ON true
    WHERE f.process_code IS NOT NULL OR x.process_instance_id IS NOT NULL OR w.purpose='purchase_expense';

    CREATE OR REPLACE VIEW costing_read.financial_template_coverage_v1 AS
    SELECT f.corp_id,f.process_code,f.template_name,f.registered_at,
      w.window_start,w.window_end,COALESCE(w.status,'not_scheduled') AS status,
      w.discovered_count,w.processed_count,jsonb_array_length(w.pending_ids) AS pending_instance_count,
      w.last_error,w.completed_at,w.updated_at,
      COALESCE(s.source_count,0::bigint) AS source_count,
      COALESCE(s.eligible_source_count,0::bigint) AS eligible_source_count,
      COALESCE(s.attachment_count,0::bigint) AS attachment_count,
      COALESCE(s.attachment_available_count,0::bigint) AS attachment_available_count
    FROM costing_read.financial_template_scope f
    LEFT JOIN costing_read.financial_backfill_window w USING(corp_id,process_code)
    LEFT JOIN (
      SELECT corp_id,process_code,count(*) AS source_count,
        count(*) FILTER(WHERE eligible_for_adoption) AS eligible_source_count,
        sum(attachment_count)::bigint AS attachment_count,
        sum(attachment_available_count)::bigint AS attachment_available_count
      FROM costing_read.financial_sources_v1 GROUP BY corp_id,process_code
    ) s USING(corp_id,process_code);

    REVOKE ALL ON costing_read.financial_source_projection FROM PUBLIC;
    REVOKE ALL ON FUNCTION costing_read.refresh_financial_reference_dependents(text,text),
      costing_read.refresh_financial_reference_template() FROM PUBLIC;
  `);
};
exports.down = () => { throw new Error('Retain snapshot projections and roll back application code only.'); };
