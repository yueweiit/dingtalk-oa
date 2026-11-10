/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // 本阶段必须保留事务原子性；锁等待或语句超时均回滚整阶段。
  pgm.sql("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '5min';");
  pgm.createTable({ schema: 'public', name: 'ding_user_fetch_failure' }, {
    id: { type: 'BIGSERIAL', primaryKey: true },
    corp_id: { type: 'VARCHAR(64)', notNull: true },
    user_id: { type: 'VARCHAR(128)', notNull: true },
    fetch_status: { type: 'VARCHAR(32)', notNull: true },
    fetch_error: { type: 'TEXT', notNull: true },
    failure_count: { type: 'BIGINT', notNull: true, default: 1 },
    first_failed_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('clock_timestamp()') },
    last_failed_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('clock_timestamp()') },
    source_snapshot_id: { type: 'BIGINT' },
    updated_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('clock_timestamp()') },
  });
  pgm.addConstraint({ schema: 'public', name: 'ding_user_fetch_failure' }, 'user_fetch_failure_source_unique', {
    unique: ['source_snapshot_id'],
  });
  pgm.addConstraint({ schema: 'public', name: 'ding_user_fetch_failure' }, 'user_fetch_failure_valid', {
    check: "fetch_status <> 'success' AND length(fetch_status) > 0 AND failure_count > 0 AND last_failed_at >= first_failed_at",
  });
  pgm.sql(`
    CREATE INDEX idx_user_fetch_failure_recent
      ON public.ding_user_fetch_failure(corp_id, user_id, last_failed_at DESC, id DESC);

    -- 部署时停止旧写入并安排读写维护窗口：末尾 ADD CHECK NOT VALID 仍需短暂排他锁。
    -- 数据整理期间允许普通读取；排他锁等待超过 5 秒则本阶段失败回滚。
    LOCK TABLE public.ding_user_snapshot IN SHARE ROW EXCLUSIVE MODE;

    -- 复制失败历史，但保留原行及 ID，避免丢失旧审计证据/破坏既有引用。
    INSERT INTO public.ding_user_fetch_failure
      (corp_id, user_id, fetch_status, fetch_error, first_failed_at, last_failed_at, source_snapshot_id, updated_at)
    SELECT corp_id, user_id,
           COALESCE(NULLIF(fetch_status, ''), 'failed'),
           COALESCE(fetch_error, 'USER_FETCH_FAILED'),
           valid_from, GREATEST(valid_from, updated_at), id, GREATEST(valid_from, updated_at)
      FROM public.ding_user_snapshot
     WHERE fetch_status IS DISTINCT FROM 'success';

    -- 先修复成功版本区间：不能将重复 current 统一关闭到迁移时刻，造成历史重叠。
    -- 同一生效时刻按 id 确定顺序，较旧版本可形成零长度区间；保留更早的已知结束时间。
    WITH success_timeline AS (
      SELECT id,
             LEAD(valid_from) OVER (PARTITION BY corp_id, user_id ORDER BY valid_from, id) AS next_success_from
        FROM public.ding_user_snapshot
       WHERE fetch_status = 'success'
    )
    UPDATE public.ding_user_snapshot s
       SET is_current = false,
           valid_to = LEAST(COALESCE(s.valid_to, t.next_success_from), t.next_success_from),
           updated_at = clock_timestamp()
      FROM success_timeline t
     WHERE s.id = t.id AND t.next_success_from IS NOT NULL
       AND (s.is_current = true OR s.valid_to IS NULL OR s.valid_to > t.next_success_from);

    -- 失败行仅作历史取证，不参与成功资料的版本区间。
    UPDATE public.ding_user_snapshot
       SET is_current = false,
           valid_to = COALESCE(valid_to, GREATEST(valid_from, clock_timestamp())),
           updated_at = clock_timestamp()
     WHERE is_current = true AND fetch_status IS DISTINCT FROM 'success';

    WITH latest_success AS (
      SELECT DISTINCT ON (corp_id, user_id) id
        FROM public.ding_user_snapshot
       WHERE fetch_status = 'success'
       ORDER BY corp_id, user_id, valid_from DESC, id DESC
    )
    UPDATE public.ding_user_snapshot s
       SET is_current = true, valid_to = NULL, updated_at = clock_timestamp()
      FROM latest_success l
     WHERE s.id = l.id AND (s.is_current = false OR s.valid_to IS NOT NULL);

    CREATE UNIQUE INDEX user_snapshot_one_current_per_user
      ON public.ding_user_snapshot(corp_id, user_id) WHERE is_current = true;

    ALTER TABLE public.ding_user_snapshot
      ADD CONSTRAINT user_snapshot_current_success
      CHECK (NOT is_current OR (fetch_status IS NOT DISTINCT FROM 'success' AND valid_to IS NULL)) NOT VALID;

    -- 不在持有 ADD CONSTRAINT 排他锁的事务中扫描校验历史行；下一迁移独立校验。

    COMMENT ON TABLE public.ding_user_fetch_failure IS
      '用户资料获取失败历史；连续相同错误累计次数，不替换最后一次成功快照';
    COMMENT ON COLUMN public.ding_user_fetch_failure.source_snapshot_id IS
      '迁移前失败快照的原始 ID，仅用于历史追溯；历史计数只包含可回溯的快照行';
  `);
};

exports.down = (pgm) => {
  // 新失败记录与恢复后的当前版本无法安全映射回旧模型，禁止自动删除或猜测恢复。
  pgm.sql("DO $$ BEGIN RAISE EXCEPTION 'USER_SNAPSHOT_MANUAL_ROLLBACK_REQUIRED'; END $$;");
};
