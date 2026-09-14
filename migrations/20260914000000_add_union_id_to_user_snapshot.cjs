/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.addColumn('ding_user_snapshot', {
    union_id: { type: 'VARCHAR(256)' },
  });

  // 兼容历史快照中钉钉返回的不同字段命名，避免升级后历史用户丢失 unionId。
  pgm.sql(`
    UPDATE ding_user_snapshot
       SET union_id = COALESCE(
         NULLIF(raw_payload->>'union_id', ''),
         NULLIF(raw_payload->>'unionId', ''),
         NULLIF(raw_payload->>'unionid', '')
       )
     WHERE union_id IS NULL
       AND raw_payload IS NOT NULL;
  `);

  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.union_id IS '钉钉用户 unionId（兼容 union_id/unionId/unionid）'`);
};

exports.down = (pgm) => {
  pgm.dropColumn('ding_user_snapshot', 'union_id');
};
