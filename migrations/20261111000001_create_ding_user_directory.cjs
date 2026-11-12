const trimCharacters = String.raw`U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'`;
const usableName = column => {
  const name = `NULLIF(BTRIM(${column}, ${trimCharacters}), '')`;
  return `CASE WHEN lower(${name}) <> 'unknown' AND char_length(${name}) <= 256 THEN ${name} END`;
};
const departureName = `COALESCE(${usableName('d.employee_name')}, ${usableName('d.dingtalk_name')})`;
const departureEvidence = `FROM public.ding_user_departure d
      JOIN public.ding_approval_instance i ON i.corp_id = d.corp_id
        AND i.process_instance_id = d.source_process_instance_id AND i.process_code = d.source_process_code
      WHERE d.user_id IS NOT NULL AND d.identity_method IN ('originator', 'manual') AND NOT d.identity_review_required
        AND i.deleted_at IS NULL AND upper(btrim(i.status)) = 'COMPLETED' AND lower(btrim(i.result)) = 'agree'`;

exports.up = pgm => {
  pgm.sql(`
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE public.ding_approval_instance ADD COLUMN originator_user_name_source_instance_id varchar(128);
    ALTER TABLE public.ding_approval_task ADD COLUMN approver_user_name_source_instance_id varchar(128);
    CREATE INDEX ding_user_departure_directory_lookup ON public.ding_user_departure (corp_id, user_id)
      WHERE user_id IS NOT NULL AND NOT identity_review_required;
    CREATE INDEX ding_approval_instance_departure_name_lookup
      ON public.ding_approval_instance (corp_id, originator_user_name_source_instance_id)
      WHERE originator_user_name_source_instance_id IS NOT NULL;
    CREATE INDEX ding_approval_task_departure_name_lookup
      ON public.ding_approval_task (corp_id, approver_user_name_source_instance_id)
      WHERE approver_user_name_source_instance_id IS NOT NULL;

    CREATE VIEW public.ding_user_directory AS
    WITH candidates AS (
      SELECT s.corp_id, s.user_id, ${usableName('s.name')} AS name,
        'snapshot'::text AS name_source, NULL::varchar(128) AS source_process_instance_id,
        0 AS priority, s.is_current, s.valid_from, s.id AS snapshot_id,
        NULL::date AS departed_on, NULL::timestamptz AS departure_updated_at
      FROM public.ding_user_snapshot s
      WHERE s.fetch_status = 'success'
      UNION ALL
      SELECT d.corp_id, d.user_id, ${departureName},
        'departure_approval', d.source_process_instance_id,
        1, NULL, NULL, NULL, d.departed_on, d.updated_at
      ${departureEvidence}
    )
    SELECT DISTINCT ON (corp_id, user_id) corp_id, user_id, name,
      CASE WHEN name IS NOT NULL THEN name_source END AS name_source,
      CASE WHEN name IS NOT NULL THEN source_process_instance_id END AS source_process_instance_id
    FROM candidates
    ORDER BY corp_id, user_id, (name IS NULL), priority, is_current DESC NULLS LAST,
      valid_from DESC NULLS LAST, snapshot_id DESC NULLS LAST,
      departed_on DESC NULLS LAST, departure_updated_at DESC NULLS LAST, source_process_instance_id DESC;

    CREATE FUNCTION public.lock_departure_directory_name(
      corp varchar, employee varchar, source_instance varchar, selected_name text
    ) RETURNS boolean LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $fn$
      SELECT EXISTS (
        SELECT 1 ${departureEvidence}
          AND d.corp_id = corp AND d.user_id = employee AND d.source_process_instance_id = source_instance
          AND ${departureName} = selected_name
        FOR SHARE OF d, i SKIP LOCKED
      );
    $fn$;

    CREATE FUNCTION public.invalidate_departure_approval_names() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    DECLARE source_instance varchar(128);
    BEGIN
      IF TG_TABLE_NAME = 'ding_approval_instance' THEN
        source_instance := OLD.process_instance_id;
      ELSE
        source_instance := OLD.source_process_instance_id;
      END IF;

      UPDATE public.ding_approval_instance SET originator_user_name = NULL,
        originator_user_name_source_instance_id = NULL, updated_at = clock_timestamp()
      WHERE corp_id = OLD.corp_id AND originator_user_name_source_instance_id = source_instance;
      UPDATE public.ding_approval_task SET approver_user_name = NULL,
        approver_user_name_source_instance_id = NULL, updated_at = clock_timestamp()
      WHERE corp_id = OLD.corp_id AND approver_user_name_source_instance_id = source_instance;
      RETURN NULL;
    END;
    $fn$;

    CREATE TRIGGER invalidate_departure_name_after_evidence_change
      AFTER UPDATE OF corp_id, source_process_instance_id, source_process_code, user_id, identity_method,
        identity_review_required, employee_name, dingtalk_name ON public.ding_user_departure
      FOR EACH ROW WHEN (ROW(OLD.corp_id, OLD.source_process_instance_id, OLD.source_process_code, OLD.user_id,
        OLD.identity_method, OLD.identity_review_required, OLD.employee_name, OLD.dingtalk_name)
        IS DISTINCT FROM ROW(NEW.corp_id, NEW.source_process_instance_id, NEW.source_process_code, NEW.user_id,
          NEW.identity_method, NEW.identity_review_required, NEW.employee_name, NEW.dingtalk_name))
      EXECUTE FUNCTION public.invalidate_departure_approval_names();
    CREATE TRIGGER invalidate_departure_name_after_evidence_delete
      AFTER DELETE ON public.ding_user_departure
      FOR EACH ROW EXECUTE FUNCTION public.invalidate_departure_approval_names();
    CREATE TRIGGER invalidate_departure_name_after_approval_change
      AFTER UPDATE OF status, result, deleted_at, process_code ON public.ding_approval_instance
      FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND upper(btrim(OLD.status)) = 'COMPLETED' AND lower(btrim(OLD.result)) = 'agree'
        AND (NEW.deleted_at IS NOT NULL OR NEW.process_code IS DISTINCT FROM OLD.process_code
          OR upper(btrim(NEW.status)) IS DISTINCT FROM 'COMPLETED' OR lower(btrim(NEW.result)) IS DISTINCT FROM 'agree'))
      EXECUTE FUNCTION public.invalidate_departure_approval_names();

    REVOKE ALL ON public.ding_user_directory FROM PUBLIC;
    COMMENT ON VIEW public.ding_user_directory IS '企业人员名录，姓名优先使用成功快照，已确认离职审批补缺';
    COMMENT ON COLUMN public.ding_approval_instance.originator_user_name_source_instance_id IS '从离职审批补齐发起人姓名时的来源实例';
    COMMENT ON COLUMN public.ding_approval_task.approver_user_name_source_instance_id IS '从离职审批补齐审批人姓名时的来源实例';
  `);
};

exports.down = () => {
  throw new Error('USER_DIRECTORY_ROLLBACK_REQUIRES_PRESERVING_NAME_PROVENANCE');
};
