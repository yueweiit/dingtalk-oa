import { searchInstances, delay } from '../dingtalk/api-client.js';
import { refreshApprovalInstance } from '../normalize/orchestrator.js';
import {
  claimFinancialWindow,saveFinancialPage,finishFinancialInstance,startNextFinancialPage,
  completeFinancialWindow,failFinancialWindow,type FinancialBackfillWindow,
} from '../db/queries/financial-backfill.js';

export interface FinancialBackfillDependencies {
  claim: typeof claimFinancialWindow;
  search: typeof searchInstances;
  refresh: (params: {corpId:string;processInstanceId:string;processCode:string}) => Promise<unknown>;
  savePage: typeof saveFinancialPage;
  finishInstance: typeof finishFinancialInstance;
  nextPage: typeof startNextFinancialPage;
  complete: typeof completeFinancialWindow;
  fail: typeof failFinancialWindow;
  wait: typeof delay;
}
const defaults: FinancialBackfillDependencies = {
  claim:claimFinancialWindow,search:searchInstances,refresh:refreshApprovalInstance,
  savePage:saveFinancialPage,finishInstance:finishFinancialInstance,nextPage:startNextFinancialPage,
  complete:completeFinancialWindow,fail:failFinancialWindow,wait:delay,
};

/** Unlimited overall history; optional invocation budget leaves every unfinished window durable. */
export async function runFinancialBackfill(
  options: {corpId:string;delayMs?:number;maxWindows?:number}, dependencies: FinancialBackfillDependencies = defaults,
): Promise<{windowsCompleted:number;windowsFailed:number;instancesProcessed:number;rateLimited:boolean}> {
  const maxWindows = options.maxWindows ?? Infinity;
  const delayMs = options.delayMs ?? 2000;
  if ((maxWindows !== Infinity && (!Number.isInteger(maxWindows) || maxWindows < 1)) || !Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error('Invalid financial backfill limits');
  }
  const retryBefore = new Date();
  const result = {windowsCompleted:0,windowsFailed:0,instancesProcessed:0,rateLimited:false};
  for (let count = 0; count < maxWindows; count++) {
    const row = await dependencies.claim(options.corpId,retryBefore);
    if (!row) break;
    try {
      await processWindow(row, dependencies, delayMs, () => { result.instancesProcessed++; });
      result.windowsCompleted++;
    } catch (error) {
      result.windowsFailed++;
      await dependencies.fail(row,error).catch(failure => {
        console.error('[FinancialBackfill] Failed to record window failure:', failure);
      });
      const message = error instanceof Error ? error.message : String(error);
      if (/\bQpsLimitForApi\b|\bHTTP\s+429\b/i.test(message)) {
        result.rateLimited=true;
        console.warn('[FinancialBackfill] API rate limit reached; ending this drain with its window left retryable.');
        break;
      }
    }
  }
  return result;
}

async function processWindow(row: FinancialBackfillWindow, deps: FinancialBackfillDependencies, delayMs: number, processed:()=>void) {
  const seenTokens = new Set<string>();
  while (true) {
    if (!row.page_loaded) {
      const requested = row.next_token;
      if (delayMs) await deps.wait(delayMs);
      const page = await deps.search({processCode:row.process_code,startTime:row.window_start,endTime:row.window_end,
        nextToken:requested ?? undefined,size:20});
      const next = page.nextToken || null;
      if (next !== null && (next === requested || seenTokens.has(String(next)))) throw new Error('Nonadvancing financial backfill pagination');
      if (next !== null) seenTokens.add(String(next));
      if (!page.list.length && next !== null) throw new Error('Empty financial backfill page has a continuation token');
      await deps.savePage(row,page.list,next);
      row.pending_ids=[...page.list]; row.next_token=next; row.page_loaded=true;
    }
    while (row.pending_ids.length) {
      if (delayMs) await deps.wait(delayMs);
      await deps.refresh({corpId:row.corp_id,processInstanceId:row.pending_ids[0],processCode:row.process_code});
      // A failure leaves this ID at the head. A crash after persistence safely replays its upsert.
      await deps.finishInstance(row);
      row.pending_ids.shift(); processed();
    }
    if (row.next_token === null) { await deps.complete(row); return; }
    await deps.nextPage(row); row.page_loaded=false;
  }
}
