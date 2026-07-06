import { getPool } from './src/db/pool.js';
import { getConfig } from './src/config/index.js';

getConfig();
const pool = getPool();

async function main() {
  const events = await pool.query('SELECT * FROM ding_event_log ORDER BY id DESC LIMIT 10');
  console.log('Events:', events.rows.length === 0 ? '(空)' : '');
  for (const e of events.rows) {
    console.log(`  [${e.status}] ${e.event_type} | ${e.process_instance_id || '-'} | ${e.source}`);
    if (e.error_message) console.log(`    Error: ${e.error_message}`);
  }

  const corps = await pool.query('SELECT * FROM ding_corp_config');
  console.log('\nCorp config:', corps.rows.length === 0 ? '(空)' : JSON.stringify(corps.rows, null, 2));

  const templates = await pool.query('SELECT process_code, name, enabled FROM ding_process_template');
  console.log('\nTemplates:', templates.rows.length === 0 ? '(空)' : '');
  for (const t of templates.rows) {
    console.log(`  ${t.enabled ? '✅' : '❌'} ${t.process_code} - ${t.name || '(未命名)'}`);
  }

  const instances = await pool.query('SELECT count(*) as cnt FROM ding_approval_instance');
  console.log('\nApproval instances:', instances.rows[0].cnt);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
