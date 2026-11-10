/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // 独立清理阶段；保持事务原子性，不修改已执行的两阶段迁移。
  pgm.sql(`
    SET LOCAL lock_timeout = '5s';
    SET LOCAL statement_timeout = '5min';
    LOCK TABLE public.ding_user_snapshot, public.ding_user_fetch_failure IN SHARE ROW EXCLUSIVE MODE;

    DO $guard$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.ding_user_snapshot'::regclass
           AND conname = 'user_snapshot_current_success' AND contype = 'c' AND convalidated
      ) THEN
        RAISE EXCEPTION 'USER_SNAPSHOT_CLEANUP_REQUIRES_VALIDATED_CONSTRAINT';
      END IF;

      -- 包括 CASCADE / SET NULL：任何外键都先交由人工核查，不触发隐式级联。
      IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
         WHERE confrelid = 'public.ding_user_snapshot'::regclass AND contype = 'f'
      ) THEN
        RAISE EXCEPTION 'USER_SNAPSHOT_CLEANUP_REFERENCES_EXIST';
      END IF;

      -- 仓库未定义这两张表的用户触发器或规则；存在自定义写入副作用时中止。
      IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger
         WHERE tgrelid IN ('public.ding_user_snapshot'::regclass, 'public.ding_user_fetch_failure'::regclass)
           AND NOT tgisinternal
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_rewrite
         WHERE ev_class IN ('public.ding_user_snapshot'::regclass, 'public.ding_user_fetch_failure'::regclass)
           AND rulename <> '_RETURN'
      ) THEN
        RAISE EXCEPTION 'USER_SNAPSHOT_CLEANUP_CUSTOM_WRITERS_EXIST';
      END IF;

      -- 不能只核对数量或 ID；同企业、用户、规范化错误及首次失败时间必须逐行对应。
      -- last_failed_at / failure_count 可已被新代码累计，不能用旧快照覆盖它们。
      IF EXISTS (
        SELECT 1 FROM public.ding_user_snapshot s
        LEFT JOIN public.ding_user_fetch_failure f ON f.source_snapshot_id = s.id
         WHERE s.fetch_status IS DISTINCT FROM 'success'
           AND (s.is_current IS DISTINCT FROM false OR f.id IS NULL
             OR f.corp_id IS DISTINCT FROM s.corp_id
             OR f.user_id IS DISTINCT FROM s.user_id
             OR f.fetch_status IS DISTINCT FROM COALESCE(NULLIF(s.fetch_status, ''), 'failed')
             OR f.fetch_error IS DISTINCT FROM COALESCE(s.fetch_error, 'USER_FETCH_FAILED')
             OR f.first_failed_at IS DISTINCT FROM s.valid_from
             OR f.last_failed_at < s.valid_from OR f.failure_count < 1)
      ) THEN
        RAISE EXCEPTION 'USER_SNAPSHOT_CLEANUP_ARCHIVE_MISMATCH';
      END IF;
    END $guard$;
  `);

  pgm.addColumn({ schema: 'public', name: 'ding_user_fetch_failure' }, {
    source_snapshot_payload: { type: 'JSONB' },
  });
  pgm.sql(`
    -- 原行完整保存，包括原始 payload、技术 ID 和版本时间；只从快照表物理移除。
    UPDATE public.ding_user_fetch_failure f
       SET source_snapshot_payload = to_jsonb(s), updated_at = clock_timestamp()
      FROM public.ding_user_snapshot s
     WHERE f.source_snapshot_id = s.id AND f.corp_id = s.corp_id AND f.user_id = s.user_id
       AND s.is_current = false AND s.fetch_status IS DISTINCT FROM 'success';

    DELETE FROM public.ding_user_snapshot s
     USING public.ding_user_fetch_failure f
     WHERE s.is_current = false AND s.fetch_status IS DISTINCT FROM 'success'
       AND f.source_snapshot_id = s.id AND f.corp_id = s.corp_id AND f.user_id = s.user_id
       AND f.source_snapshot_payload = to_jsonb(s);

    DO $verify$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.ding_user_snapshot WHERE fetch_status IS DISTINCT FROM 'success') THEN
        RAISE EXCEPTION 'USER_SNAPSHOT_CLEANUP_INCOMPLETE';
      END IF;
    END $verify$;

    COMMENT ON COLUMN public.ding_user_fetch_failure.source_snapshot_payload IS
      '旧失败快照清理前的完整原行 JSON；保留原 ID、原始数据和版本时间，供追溯及人工恢复';
    COMMENT ON COLUMN public.ding_user_fetch_failure.source_snapshot_id IS
      '旧失败快照原始 ID（历史来源标识，非外键）；清理后原行保存在 source_snapshot_payload';
  `);
};

exports.down = (pgm) => {
  pgm.sql("DO $$ BEGIN RAISE EXCEPTION 'USER_SNAPSHOT_CLEANUP_MANUAL_ROLLBACK_REQUIRED'; END $$;");
};
