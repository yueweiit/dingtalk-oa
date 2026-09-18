/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE ding_approval_instance
    SET create_time = ((raw_payload ->> 'createTime')::timestamp AT TIME ZONE 'Asia/Shanghai'),
        updated_at = now()
    WHERE raw_payload ->> 'createTime' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?Z$'
      AND create_time > updated_at + interval '1 hour';

    UPDATE ding_approval_task
    SET start_time = ((COALESCE(raw_payload ->> 'startTime', raw_payload ->> 'createTime'))::timestamp AT TIME ZONE 'Asia/Shanghai'),
        updated_at = now()
    WHERE COALESCE(raw_payload ->> 'startTime', raw_payload ->> 'createTime') ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?Z$'
      AND start_time > updated_at + interval '1 hour';
  `);
};

exports.down = () => {};
