/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`COMMENT ON TABLE ding_business_entity IS '业务主体配置 - 审批表单可选择的业务主体字典'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity.id IS '主键ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity.corp_id IS '钉钉企业ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity.business_code IS '业务主体编码，供连接器接口使用'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity.name IS '业务主体显示名称'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity.is_active IS '是否启用，false表示不再提供给审批表单使用'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity.created_at IS '记录创建时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity.updated_at IS '记录最后更新时间'`);

  pgm.sql(`COMMENT ON TABLE ding_business_entity_approver IS '业务主体审批人配置 - 业务主体与钉钉审批人的映射关系'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.id IS '主键ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.corp_id IS '钉钉企业ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.business_code IS '业务主体编码'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.user_id IS '钉钉审批人用户ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.priority IS '审批人优先级，数值越小越靠前'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.is_active IS '是否启用，false表示不返回该审批人'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.created_at IS '记录创建时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.updated_at IS '记录最后更新时间'`);
};

exports.down = (pgm) => {
  pgm.sql(`COMMENT ON TABLE ding_business_entity IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity.id IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity.corp_id IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity.business_code IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity.name IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity.is_active IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity.created_at IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity.updated_at IS NULL`);

  pgm.sql(`COMMENT ON TABLE ding_business_entity_approver IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.id IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.corp_id IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.business_code IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.user_id IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.priority IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.is_active IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.created_at IS NULL`);
  pgm.sql(`COMMENT ON COLUMN ding_business_entity_approver.updated_at IS NULL`);
};
