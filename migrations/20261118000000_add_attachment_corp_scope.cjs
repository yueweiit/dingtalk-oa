/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE costing_read.attachment_corp_scope (
      corp_id varchar(64) PRIMARY KEY CHECK (corp_id <> '' AND corp_id = btrim(corp_id)),
      enabled boolean NOT NULL DEFAULT true
    );

    -- Explicit collection scope: corporation-wide OR individually enabled templates.
    -- Do not expand eligible_attachment_instances or the financial read/adoption contracts.
    CREATE OR REPLACE VIEW costing_read.attachment_template_instances AS
    SELECT i.* FROM public.ding_approval_instance i
    WHERE i.deleted_at IS NULL AND (
      EXISTS (
        SELECT 1 FROM costing_read.attachment_corp_scope c
        WHERE c.corp_id=i.corp_id AND c.enabled
      ) OR EXISTS (
        SELECT 1 FROM costing_read.attachment_template_scope t
        WHERE t.corp_id=i.corp_id AND t.process_code=i.process_code AND t.enabled
      )
    );

    REVOKE ALL ON TABLE costing_read.attachment_corp_scope FROM PUBLIC;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE VIEW costing_read.attachment_template_instances AS
    SELECT i.* FROM public.ding_approval_instance i
    JOIN costing_read.attachment_template_scope s USING (corp_id, process_code)
    WHERE s.enabled AND i.deleted_at IS NULL;

    DROP TABLE costing_read.attachment_corp_scope;
  `);
};
