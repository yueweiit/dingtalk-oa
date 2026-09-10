import { readFile } from 'node:fs/promises';
import {getConfig} from '../src/config/index.js';
import {getTemplateAdminUserId} from '../src/dingtalk/template-admin-user.js';
import {closePool,withClient} from '../src/db/pool.js';
import {discoverFinancialTemplates} from '../src/jobs/financial-template-discovery.js';
import {enqueueFinancialWindows} from '../src/db/queries/financial-backfill.js';
import {runFinancialBackfill} from '../src/jobs/financial-backfill.js';

const args=process.argv.slice(2);
const arg=(name:string)=>args.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);

async function main() {
  if(args.includes('--help')) {
    console.log(`Usage: npm run finance:backfill -- [options]
  --corp-id=ID         Corporate ID; defaults to configured DINGTALK_CORP_ID
  --names-file=PATH    Private JSON array of exact historical financial template names
  --template-name=NAME Exact historical name (repeatable); names persist for retry
  --start=YYYY-MM-DD   Inclusive Asia/Shanghai start (default 2026-01-01)
  --end=YYYY-MM-DD     Exclusive Asia/Shanghai end (default start of today, capped at 2027-01-01)
  --max-windows=N      Optional invocation budget; no overall record or window cap
  --delay-ms=N         Delay per approval (default 500; minimum 500)
  --discover-only     Discover/register templates and seed windows, without fetching instances
  --resume-only       Skip discovery and scheduling; resume existing durable windows
  --no-current        Skip current template list; still resolve retained/historical names
  --status            Read per-process window and attachment coverage only
Use a fixed end date when resuming an initial scan. Completed exact windows are never reset.
This command downloads no documents and calls no AI. The existing eligible attachment worker runs separately.`);
    return;
  }
  const config=getConfig();
  const corpId=arg('corp-id') ?? config.DINGTALK_CORP_ID;
  if(!corpId) throw new Error('A corporate ID is required');
  if(args.includes('--status')) {
    const status=await withClient(async client=>({
      coverage:(await client.query(`SELECT * FROM costing_read.financial_template_coverage_v1
        WHERE corp_id=$1 ORDER BY process_code,window_start`,[corpId])).rows,
      discovery:(await client.query(`SELECT * FROM costing_read.financial_template_discovery_v1
        WHERE corp_id=$1 ORDER BY template_name`,[corpId])).rows,
    }));
    console.log(JSON.stringify(status,null,2)); return;
  }
  const maxWindows=arg('max-windows')===undefined?undefined:Number(arg('max-windows'));
  const delayMs=Number(arg('delay-ms')??500);
  if(!Number.isInteger(delayMs)||delayMs<500||delayMs>10000) throw new Error('delay-ms must be 500–10000');
  if(maxWindows!==undefined&&(!Number.isInteger(maxWindows)||maxWindows<1)) throw new Error('max-windows must be a positive integer');
  let discoveryFailed=0;
  if(!args.includes('--resume-only')) {
    const names=args.filter(value=>value.startsWith('--template-name=')).map(value=>value.slice('--template-name='.length));
    const namesFile=arg('names-file');
    if(namesFile) {
      const values:unknown=JSON.parse(await readFile(namesFile,'utf8'));
      if(!Array.isArray(values)||values.some(value=>typeof value!=='string'||!value.trim())) throw new Error('names-file must contain a JSON array of nonempty exact names');
      names.push(...values as string[]);
    }
    const shanghaiDate=(value:string)=> {
      if(!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Dates must use YYYY-MM-DD');
      const date=new Date(`${value}T00:00:00+08:00`);
      if(!Number.isFinite(date.getTime())) throw new Error('Invalid date');
      return date;
    };
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const start=shanghaiDate(arg('start')??'2026-01-01');
    const end=shanghaiDate(arg('end')??(today<'2027-01-01'?today:'2027-01-01'));
    if(start>=end) throw new Error('Start must precede end');
    const result=await discoverFinancialTemplates({corpId,names,
      userId:args.includes('--no-current')?undefined:getTemplateAdminUserId(config)});
    discoveryFailed=result.failed;
    console.log('Financial template discovery:',result);
    console.log('New durable windows:',await enqueueFinancialWindows(corpId,start,end));
  }
  if(!args.includes('--discover-only')) {
    const result=await runFinancialBackfill({corpId,maxWindows,delayMs});
    console.log('Financial archive progress:',result);
    if(result.windowsFailed) process.exitCode=1;
  }
  if(discoveryFailed) process.exitCode=1;
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}).finally(closePool);
