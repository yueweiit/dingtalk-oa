/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // 必须打断迁移器 singleTransaction：先提交上一阶段，释放 ADD CHECK 的排他锁。
  // 这里只校验已存在约束，可安全重试；校验失败不会撤销已提交的数据整理阶段。
  pgm.noTransaction();
  pgm.sql(`
    BEGIN;
    SET LOCAL lock_timeout = '5s';
    SET LOCAL statement_timeout = '5min';
    ALTER TABLE public.ding_user_snapshot VALIDATE CONSTRAINT user_snapshot_current_success;
    COMMIT
  `.trim());
};

exports.down = (pgm) => {
  pgm.sql("DO $$ BEGIN RAISE EXCEPTION 'USER_SNAPSHOT_MANUAL_ROLLBACK_REQUIRED'; END $$;");
};
