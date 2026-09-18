import { withClient, withTransaction } from '../pool.js';

export interface FinancialBackfillWindow {
  corp_id: string;
  process_code: string;
  window_start: Date;
  window_end: Date;
  next_token: string | number | null;
  pending_ids: string[];
  page_loaded: boolean;
  lease_generation: string;
  processed_count: string;
  discovered_count: string;
}

const key = (row: FinancialBackfillWindow) => [row.corp_id, row.process_code, row.window_start, row.window_end, row.lease_generation];
const fence = `corp_id=$1 AND process_code=$2 AND window_start=$3 AND window_end=$4
  AND lease_generation=$5 AND status='running' AND lease_until>clock_timestamp()`;

/** Persist fixed windows once; existing completion and in-flight progress are never reset. */
export async function enqueueFinancialWindows(corpId: string, start: Date, end: Date, chunkDays = 7): Promise<number> {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end
    || !Number.isInteger(chunkDays) || chunkDays < 1 || chunkDays > 7) throw new Error('Invalid financial backfill window');
  return withTransaction(async client => {
    let count = 0;
    for (let time = start.getTime(); time < end.getTime(); time += chunkDays * 86400000) {
      const result = await client.query(`INSERT INTO costing_read.financial_backfill_window(corp_id,process_code,window_start,window_end)
        SELECT corp_id,process_code,$2,$3 FROM costing_read.financial_template_scope WHERE corp_id=$1
        ON CONFLICT(corp_id,process_code,window_start,window_end) DO NOTHING`,
      [corpId, new Date(time), new Date(Math.min(time + chunkDays * 86400000, end.getTime()))]);
      count += result.rowCount ?? 0;
    }
    return count;
  });
}

export async function claimFinancialWindow(corpId: string, retryBefore = new Date()): Promise<FinancialBackfillWindow | null> {
  return withTransaction(async client => {
    const { rows } = await client.query<FinancialBackfillWindow>(`WITH picked AS (
      SELECT corp_id,process_code,window_start,window_end FROM costing_read.financial_backfill_window
      WHERE corp_id=$1 AND (status='pending' OR (status='failed' AND updated_at<LEAST($2::timestamptz,clock_timestamp()-interval '1 minute'))
        OR (status='running' AND lease_until<=clock_timestamp()))
      ORDER BY updated_at,window_start,process_code FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE costing_read.financial_backfill_window w
      SET status='running',lease_until=clock_timestamp()+interval '15 minutes',lease_generation=w.lease_generation+1,
        updated_at=clock_timestamp(),last_error=NULL
      FROM picked p WHERE w.corp_id=p.corp_id AND w.process_code=p.process_code
        AND w.window_start=p.window_start AND w.window_end=p.window_end RETURNING w.*`, [corpId,retryBefore]);
    return rows[0] ?? null;
  });
}

async function updateClaim(row: FinancialBackfillWindow, set: string, values: unknown[] = []): Promise<void> {
  await withClient(async client => {
    const result = await client.query(`UPDATE costing_read.financial_backfill_window SET ${set},updated_at=clock_timestamp()
      WHERE ${fence}`, [...key(row), ...values]);
    if (result.rowCount !== 1) throw new Error('Financial backfill lease lost; progress was not advanced');
  });
}

export async function saveFinancialPage(row: FinancialBackfillWindow, ids: string[], nextToken: string | number | null): Promise<void> {
  await updateClaim(row, `pending_ids=$6::jsonb,next_token=$7::jsonb,page_loaded=true,
    discovered_count=discovered_count+jsonb_array_length($6::jsonb),lease_until=clock_timestamp()+interval '15 minutes'`,
  [JSON.stringify(ids), JSON.stringify(nextToken)]);
}

export async function finishFinancialInstance(row: FinancialBackfillWindow): Promise<void> {
  await updateClaim(row, `pending_ids=pending_ids-0,processed_count=processed_count+1,lease_until=clock_timestamp()+interval '15 minutes'`);
}

export async function startNextFinancialPage(row: FinancialBackfillWindow): Promise<void> {
  await updateClaim(row, `page_loaded=false,lease_until=clock_timestamp()+interval '15 minutes'`);
}

export async function completeFinancialWindow(row: FinancialBackfillWindow): Promise<void> {
  await updateClaim(row, `status='completed',completed_at=clock_timestamp(),lease_until=NULL,last_error=NULL`);
}

export async function failFinancialWindow(row: FinancialBackfillWindow, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await updateClaim(row, `status='failed',lease_until=NULL,last_error=$6`, [message.slice(0,4000)]);
}
