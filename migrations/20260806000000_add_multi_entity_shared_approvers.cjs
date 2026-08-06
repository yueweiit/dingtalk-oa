/** @type {import('node-pg-migrate').MigrationBuilder} */
const CORP_ID = 'ding144583309b2fb01c35c2f4657eb6378f';
const BUSINESS_CODE = 'MULTI_ENTITY_SHARED';
const BUSINESS_NAME = '多主体共用 Compartido por varias empresas';
const USER_IDS = [
  '163527194432506164',
  '235618600659-1837231668',
  '181224042621645530',
  '235628584058-1672651368',
  '16693147192083157833',
];

exports.up = (pgm) => {
  pgm.sql(
    `INSERT INTO ding_business_entity (corp_id, business_code, name)
     VALUES ('${CORP_ID}', '${BUSINESS_CODE}', '${BUSINESS_NAME}')
     ON CONFLICT (corp_id, business_code)
     DO UPDATE SET name = EXCLUDED.name, is_active = true, updated_at = now()`
  );

  for (const userId of USER_IDS) {
    pgm.sql(
      `INSERT INTO ding_business_entity_approver (corp_id, business_code, user_id)
       VALUES ('${CORP_ID}', '${BUSINESS_CODE}', '${userId}')
       ON CONFLICT (corp_id, business_code, user_id)
       DO UPDATE SET is_active = true, updated_at = now()`
    );
  }
};

exports.down = (pgm) => {
  pgm.sql(
    `DELETE FROM ding_business_entity_approver
     WHERE corp_id = '${CORP_ID}' AND business_code = '${BUSINESS_CODE}'`
  );
  pgm.sql(
    `DELETE FROM ding_business_entity
     WHERE corp_id = '${CORP_ID}' AND business_code = '${BUSINESS_CODE}'`
  );
};
