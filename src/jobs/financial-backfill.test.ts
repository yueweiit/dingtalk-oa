import { describe, expect, it, vi } from 'vitest';
import * as job from './financial-backfill.js';
import type { FinancialBackfillWindow } from '../db/queries/financial-backfill.js';
const window = (): FinancialBackfillWindow => ({ corp_id:'corp',process_code:'HISTORY',
  window_start:new Date('2026-01-01T00:00:00Z'), window_end:new Date('2026-01-08T00:00:00Z'),
  next_token:null,pending_ids:[],page_loaded:false,lease_generation:'1',processed_count:'0',discovered_count:'0' });
const setup = (row = window()) => {
  const state = { row, completed:false, failed:false, claimed:false, persisted:[] as string[] };
  const dependencies = {
    claim: async () => { if (state.claimed) return null; state.claimed=true; return structuredClone(state.row); },
    search: vi.fn().mockResolvedValue({list:[]}),
    refresh: vi.fn(async ({processInstanceId}: { processInstanceId:string }) => { state.persisted.push(processInstanceId); }),
    savePage: async (_: unknown, ids:string[], token:string|number|null) => { Object.assign(state.row,{pending_ids:ids,next_token:token,page_loaded:true}); },
    finishInstance: async () => { state.row.pending_ids=state.row.pending_ids.slice(1); },
    nextPage: async () => { state.row.page_loaded=false; },
    complete: async () => { state.completed=true; },
    fail: async () => { state.failed=true; },
    wait: async (_ms:number) => undefined,
  };
  return {state,dependencies};
};

describe('durable financial backfill', () => {
  it('resumes stored page IDs before searching, and traverses every page without a total-record cap', async () => {
    const {state,dependencies} = setup({...window(),page_loaded:true,pending_ids:['remaining'],next_token:20});
    dependencies.search.mockResolvedValueOnce({list:Array.from({length:20},(_,i)=>`page2-${i}`),nextToken:40})
      .mockResolvedValueOnce({list:['last']});
    const result = await job.runFinancialBackfill({corpId:'corp',delayMs:0},dependencies);
    expect(state.persisted).toEqual(['remaining',...Array.from({length:20},(_,i)=>`page2-${i}`),'last']);
    expect(dependencies.search.mock.calls.map(([query])=>query.nextToken)).toEqual([20,40]);
    expect(result).toEqual({windowsCompleted:1,windowsFailed:0,instancesProcessed:22,rateLimited:false});
    expect(state.completed).toBe(true);
  });

  it('does not checkpoint past a failed instance and resumes only remaining IDs on a later run', async () => {
    const {state,dependencies} = setup();
    dependencies.search.mockResolvedValueOnce({list:['saved','fails','later']});
    dependencies.refresh.mockImplementationOnce(async () => {state.persisted.push('saved');})
      .mockRejectedValueOnce(new Error('temporary API failure'));
    expect(await job.runFinancialBackfill({corpId:'corp',delayMs:0},dependencies)).toMatchObject({windowsCompleted:0,windowsFailed:1});
    expect(state.completed).toBe(false); expect(state.row.pending_ids).toEqual(['fails','later']);
    state.claimed=false;
    dependencies.refresh.mockImplementation(async ({processInstanceId}) => {state.persisted.push(processInstanceId);});
    await job.runFinancialBackfill({corpId:'corp',delayMs:0},dependencies);
    expect(state.persisted).toEqual(['saved','fails','later']);
    expect(dependencies.search).toHaveBeenCalledTimes(1);
    expect(state.completed).toBe(true);
  });

  it('rejects nonadvancing pagination instead of looping or declaring coverage complete', async () => {
    const {state,dependencies} = setup({...window(),next_token:'page-2'});
    dependencies.search.mockResolvedValue({list:['duplicate'],nextToken:'page-2'});
    await job.runFinancialBackfill({corpId:'corp',delayMs:0},dependencies);
    expect(state.failed).toBe(true); expect(state.completed).toBe(false);
    expect(state.persisted).toEqual([]);
  });

  it('supports a per-invocation window budget while leaving durable remaining work for the next run', async () => {
    const {dependencies} = setup();
    dependencies.claim=vi.fn(async () => window());
    expect(await job.runFinancialBackfill({corpId:'corp',delayMs:0,maxWindows:2},dependencies))
      .toMatchObject({windowsCompleted:2,windowsFailed:0});
    expect(dependencies.claim).toHaveBeenCalledTimes(2);
  });
  it('paces every remote request including searches across empty windows', async () => {
    const {dependencies}=setup(); const events:string[]=[];
    dependencies.claim=vi.fn(async()=>window());
    dependencies.wait=async(ms:number)=>{events.push(`wait:${ms}`);};
    dependencies.search.mockImplementationOnce(async()=>{events.push('search');return {list:['one']};})
      .mockImplementationOnce(async()=>{events.push('search');return {list:[]};});
    dependencies.refresh.mockImplementation(async()=>{events.push('refresh');});
    await job.runFinancialBackfill({corpId:'corp',delayMs:2000,maxWindows:2},dependencies);
    expect(events).toEqual(['wait:2000','search','wait:2000','refresh','wait:2000','search']);
  });

  it.each(['API 调用失败: HTTP 403 {"code":"Forbidden.AccessDenied.QpsLimitForApi"}',
    'API 调用失败: HTTP 429 Too Many Requests'])('stops the drain on rate limiting and leaves the window retryable: %s',async message=>{
    const {state,dependencies}=setup(); dependencies.claim=vi.fn(async()=>structuredClone(state.row));
    dependencies.search.mockRejectedValueOnce(new Error(message));
    const result=await job.runFinancialBackfill({corpId:'corp',delayMs:0,maxWindows:3},dependencies);
    expect(result).toMatchObject({windowsCompleted:0,windowsFailed:1,rateLimited:true});
    expect(dependencies.claim).toHaveBeenCalledTimes(1); expect(state.failed).toBe(true);
    expect(state.row.page_loaded).toBe(false);
    dependencies.search.mockResolvedValue({list:[]});
    expect(await job.runFinancialBackfill({corpId:'corp',delayMs:0,maxWindows:1},dependencies))
      .toMatchObject({windowsCompleted:1,windowsFailed:0,rateLimited:false});
  });

  it('retains the current detail ID and stops before another window on wrapped QPS errors',async()=>{
    const {state,dependencies}=setup({...window(),page_loaded:true,pending_ids:['limited','later']});
    dependencies.claim=vi.fn(async()=>structuredClone(state.row));
    dependencies.refresh.mockRejectedValue(new Error('getInstance 失败: HTTP 403 Forbidden.AccessDenied.QpsLimitForApi'));
    expect(await job.runFinancialBackfill({corpId:'corp',delayMs:0,maxWindows:3},dependencies)).toMatchObject({rateLimited:true});
    expect(dependencies.claim).toHaveBeenCalledTimes(1); expect(state.row.pending_ids).toEqual(['limited','later']);
    expect(state.persisted).toEqual([]);
  });

  it('keeps ordinary access failures distinct from QPS limiting',async()=>{
    const {dependencies}=setup(); dependencies.claim=vi.fn(async()=>window());
    dependencies.search.mockRejectedValueOnce(new Error('HTTP 403 Forbidden.AccessDenied.PermissionDenied')).mockResolvedValue({list:[]});
    expect(await job.runFinancialBackfill({corpId:'corp',delayMs:0,maxWindows:2},dependencies))
      .toMatchObject({windowsCompleted:1,windowsFailed:1,rateLimited:false});
    expect(dependencies.claim).toHaveBeenCalledTimes(2);
  });

});
