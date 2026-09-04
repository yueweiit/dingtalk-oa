/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
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
      SELECT refs.corp_id,
             refs.user_id,
             u.name,
             u.title,
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

    COMMENT ON VIEW costing_read.approval_actor_names_v1 IS
      '仅暴露成本系统白名单审批中实际出现的发起人、操作人和评论人姓名';

    DO $grant$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'costing_reader') THEN
        GRANT USAGE ON SCHEMA costing_read TO costing_reader;
        GRANT SELECT ON costing_read.approval_actor_names_v1 TO costing_reader;
      END IF;
    END
    $grant$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $revoke$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'costing_reader') THEN
        REVOKE SELECT ON costing_read.approval_actor_names_v1 FROM costing_reader;
      END IF;
    END
    $revoke$;
    DROP VIEW IF EXISTS costing_read.approval_actor_names_v1;
  `);
};
