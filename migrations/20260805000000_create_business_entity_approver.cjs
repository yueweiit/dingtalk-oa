/** @type {import('node-pg-migrate').MigrationBuilder} */
const CORP_ID = 'ding144583309b2fb01c35c2f4657eb6378f';

const entities = [
  ['LATIN_GO', '拉丁购LatinGo', '163527194432506164'],
  ['YUEWEI_MX', 'YUEWEI MX', '235618600659-1837231668'],
  ['YW_MOLDES_UV', 'YW MOLDES/UV', '181224042621645530'],
  ['LEMOS_MX', 'LEMOS MX', '235628584058-1672651368'],
  ['YUEWEI_GROUP', 'YUEWEI Grupo悦为集团', '16693147192083157833'],
  ['LINGXIANG_XINGMING', '广州凌翔/东莞星铭', '16693147192083157833'],
];

exports.up = (pgm) => {
  pgm.createTable('ding_business_entity', {
    id: { type: 'BIGSERIAL', primaryKey: true },
    corp_id: { type: 'VARCHAR(64)', notNull: true },
    business_code: { type: 'VARCHAR(128)', notNull: true },
    name: { type: 'VARCHAR(256)', notNull: true },
    is_active: { type: 'BOOLEAN', notNull: true, default: true },
    created_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('ding_business_entity', 'ding_business_entity_corp_code_unique', {
    unique: ['corp_id', 'business_code'],
  });

  pgm.createTable('ding_business_entity_approver', {
    id: { type: 'BIGSERIAL', primaryKey: true },
    corp_id: { type: 'VARCHAR(64)', notNull: true },
    business_code: { type: 'VARCHAR(128)', notNull: true },
    user_id: { type: 'VARCHAR(128)', notNull: true },
    priority: { type: 'INTEGER', notNull: true, default: 100 },
    is_active: { type: 'BOOLEAN', notNull: true, default: true },
    created_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'TIMESTAMPTZ', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('ding_business_entity_approver', 'ding_business_entity_approver_unique', {
    unique: ['corp_id', 'business_code', 'user_id'],
  });
  pgm.createIndex('ding_business_entity_approver', ['corp_id', 'business_code'], {
    name: 'idx_business_entity_approver_lookup',
  });

  for (const [businessCode, name, userId] of entities) {
    pgm.sql(
      `INSERT INTO ding_business_entity (corp_id, business_code, name)
       VALUES ('${CORP_ID}', '${businessCode}', '${name.replace(/'/g, "''")}')`
    );
    pgm.sql(
      `INSERT INTO ding_business_entity_approver (corp_id, business_code, user_id)
       VALUES ('${CORP_ID}', '${businessCode}', '${userId}')`
    );
  }
};

exports.down = (pgm) => {
  pgm.dropTable('ding_business_entity_approver');
  pgm.dropTable('ding_business_entity');
};
