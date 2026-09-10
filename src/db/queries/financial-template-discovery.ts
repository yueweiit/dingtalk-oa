import {withClient,withTransaction} from '../pool.js';

export async function localFinancialTemplateNames(corpId:string): Promise<string[]> {
  return withClient(async client => {
    const {rows} = await client.query<{name:string}>(`SELECT DISTINCT name FROM public.ding_process_template
      WHERE corp_id=$1 AND costing_read.is_financial_template(name)
      UNION SELECT template_name FROM costing_read.financial_template_scope WHERE corp_id=$1`, [corpId]);
    return rows.map(row=>row.name);
  });
}
export async function seedFinancialTemplateNames(corpId:string,names:string[]): Promise<void> {
  await withClient(async client => {
    await client.query(`INSERT INTO costing_read.financial_template_discovery(corp_id,template_name)
      SELECT $1,name FROM unnest($2::text[]) name ON CONFLICT(corp_id,template_name) DO NOTHING`, [corpId,names]);
  });
}
export async function pendingFinancialTemplateNames(corpId:string): Promise<string[]> {
  return withClient(async client => {
    const {rows}=await client.query<{template_name:string}>(`SELECT template_name FROM costing_read.financial_template_discovery
      WHERE corp_id=$1 AND status<>'resolved' ORDER BY last_checked_at ASC NULLS FIRST,template_name`,[corpId]);
    return rows.map(row=>row.template_name);
  });
}
export async function registerDiscoveredFinancialTemplate(corpId:string,processCode:string,name:string,current=false): Promise<void> {
  await withTransaction(async client => {
    // Current-list discoveries start active; existing disabled/history settings are preserved.
    await client.query(`INSERT INTO public.ding_process_template(corp_id,process_code,name,enabled)
      VALUES($1,$2,$3,$4) ON CONFLICT(corp_id,process_code) DO UPDATE SET name=COALESCE(ding_process_template.name,EXCLUDED.name)`,[corpId,processCode,name,current]);
    await client.query(`INSERT INTO costing_read.allowed_process_template(process_code,purpose,archive_attachments,auto_registered_purchase)
      VALUES($1,'purchase_expense',false,true) ON CONFLICT(process_code) DO NOTHING`,[processCode]);
    await client.query(`INSERT INTO costing_read.purchase_template_scope(corp_id,process_code)
      VALUES($1,$2) ON CONFLICT(corp_id,process_code) DO NOTHING`,[corpId,processCode]);
    await client.query(`INSERT INTO costing_read.financial_template_scope(corp_id,process_code,template_name)
      VALUES($1,$2,$3) ON CONFLICT(corp_id,process_code) DO NOTHING`,[corpId,processCode,name]);
    await client.query(`INSERT INTO costing_read.financial_template_discovery(corp_id,template_name,process_code,status,attempts,last_checked_at)
      VALUES($1,$2,$3,'resolved',1,clock_timestamp()) ON CONFLICT(corp_id,template_name) DO UPDATE SET
        process_code=EXCLUDED.process_code,status='resolved',attempts=financial_template_discovery.attempts+1,
        last_checked_at=clock_timestamp(),last_error=NULL`,[corpId,name,processCode]);
  });
}
export async function recordFinancialDiscoveryFailure(corpId:string,name:string,error:unknown): Promise<void> {
  const message=error instanceof Error?error.message:String(error);
  await withClient(async client => {
    await client.query(`UPDATE costing_read.financial_template_discovery SET status='failed',attempts=attempts+1,
      last_checked_at=clock_timestamp(),last_error=$3 WHERE corp_id=$1 AND template_name=$2`,[corpId,name,message.slice(0,4000)]);
  });
}
