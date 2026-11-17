/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE costing_read.attachment_template_scope (
      corp_id varchar(64) NOT NULL CHECK (corp_id <> '' AND corp_id = btrim(corp_id)),
      process_code varchar(128) NOT NULL CHECK (process_code <> '' AND process_code = btrim(process_code)),
      enabled boolean NOT NULL DEFAULT true,
      PRIMARY KEY (corp_id, process_code)
    );

    CREATE VIEW costing_read.attachment_template_instances AS
    SELECT i.* FROM public.ding_approval_instance i
    JOIN costing_read.attachment_template_scope s USING (corp_id, process_code)
    WHERE s.enabled AND i.deleted_at IS NULL;

    -- The legacy eligibility view also gates the costing v1 read contract.
    CREATE VIEW costing_read.attachment_collection_instances AS
    SELECT i.* FROM public.ding_approval_instance i
    WHERE i.deleted_at IS NULL AND (
      EXISTS (
        SELECT 1 FROM costing_read.attachment_template_instances t
        WHERE t.corp_id=i.corp_id AND t.process_instance_id=i.process_instance_id
      ) OR EXISTS (
        SELECT 1 FROM costing_read.eligible_attachment_instances e
        WHERE e.corp_id=i.corp_id AND e.process_instance_id=i.process_instance_id
      )
    );

    REVOKE ALL ON TABLE costing_read.attachment_template_scope,
      costing_read.attachment_template_instances, costing_read.attachment_collection_instances FROM PUBLIC;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP VIEW costing_read.attachment_collection_instances;
    DROP VIEW costing_read.attachment_template_instances;
    DROP TABLE costing_read.attachment_template_scope;
  `);
};
