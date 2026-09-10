import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema } from '../config/schema.js';

const state = vi.hoisted(() => ({
  enabled: true,
  financialEnabled: false,
  corpId: 'corp',
  financial: vi.fn(),
  schedules: [] as Array<{ expression: string; run: () => Promise<void> }>,
  refresh: vi.fn(),
}));
vi.mock('node-cron', () => ({ default: { schedule: (expression: string, run: () => Promise<void>) => {
  state.schedules.push({ expression, run });
  return { stop: vi.fn() };
} } }));
vi.mock('../config/index.js', () => ({ getConfig: () => ({
  FINANCIAL_BACKFILL_ENABLED: state.financialEnabled,
  FINANCIAL_BACKFILL_CRON: '*/10 * * * *',
  FINANCIAL_BACKFILL_MAX_WINDOWS: 1,
  FINANCIAL_BACKFILL_DELAY_MS: 2000,
  DINGTALK_CORP_ID: state.corpId,
  COMPLETED_APPROVAL_REFRESH_ENABLED: state.enabled,
  COMPLETED_APPROVAL_REFRESH_CRON: '*/30 * * * *',
  COMPLETED_APPROVAL_REFRESH_BATCH_SIZE: 10,
  COMPLETED_APPROVAL_REFRESH_DELAY_MS: 1000,
  COMPLETED_APPROVAL_REFRESH_MIN_INTERVAL_SECONDS: 21600,
  APPROVAL_STATUS_RECONCILE_CRON: '*/15 * * * *',
  APPROVAL_STATUS_RECONCILE_BATCH_SIZE: 100,
}) }));
vi.mock('./completed-approval-refresh.js', () => ({ refreshCompletedLogisticsApprovals: state.refresh }));
vi.mock('../db/queries/corp-config.js',()=>({getAllCorpIds:async()=>[{corp_id:'first'},{corp_id:'second'}]}));
vi.mock('./financial-backfill.js', () => ({ runFinancialBackfill: state.financial }));
import { startScheduler, stopScheduler } from './scheduler.js';

afterEach(() => { stopScheduler(); state.schedules.length = 0; state.refresh.mockReset(); state.financial.mockReset(); state.financialEnabled=false; state.corpId='corp'; });

describe('completed approval refresh scheduling', () => {
  it('has bounded, explicitly enabled configuration', () => {
    const environment = { PGUSER: 'x', PGPASSWORD: 'x', PGDATABASE: 'x', DINGTALK_APP_KEY: 'x', DINGTALK_APP_SECRET: 'x' };
    const config = configSchema.parse(environment);
    expect(config).toMatchObject({ COMPLETED_APPROVAL_REFRESH_ENABLED: false,
      COMPLETED_APPROVAL_REFRESH_BATCH_SIZE: 10, COMPLETED_APPROVAL_REFRESH_MIN_INTERVAL_SECONDS: 21600 });
    expect(configSchema.safeParse({ ...environment, COMPLETED_APPROVAL_REFRESH_BATCH_SIZE: 101 }).success).toBe(false);
  });

  it('registers periodic work and suppresses overlapping invocations until it completes', async () => {
    state.enabled = true;
    let release!: () => void;
    state.refresh.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    startScheduler();
    const task = state.schedules.find(row => row.expression === '*/30 * * * *');
    expect(task).toBeDefined();
    const running = task!.run();
    await task!.run();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.refresh).toHaveBeenCalledWith({ limit: 10, delayMs: 1000, minIntervalSeconds: 21600 });
    release();
    await running;
  });

  it('does not schedule API polling while disabled', () => {
    state.enabled = false;
    startScheduler();
    expect(state.schedules.some(row => row.expression === '*/30 * * * *')).toBe(false);
  });
});

it('drains durable financial history in bounded nonoverlapping scheduled invocations', async () => {
  state.financialEnabled=true;
  let release!:()=>void;
  state.financial.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
  startScheduler();
  const task=state.schedules.find(row=>row.expression==='*/10 * * * *');
  expect(task).toBeDefined();
  const running=task!.run(); await task!.run();
  expect(state.financial).toHaveBeenCalledTimes(1);
  expect(state.financial).toHaveBeenCalledWith({corpId:'corp',maxWindows:1,delayMs:2000});
  release(); await running;
});

it('has a bounded dedicated financial request interval and an offset schedule',()=>{
  const env={PGUSER:'x',PGPASSWORD:'x',PGDATABASE:'x',DINGTALK_APP_KEY:'x',DINGTALK_APP_SECRET:'x'};
  expect(configSchema.parse(env)).toMatchObject({FINANCIAL_BACKFILL_DELAY_MS:2000,FINANCIAL_BACKFILL_CRON:'7-57/10 * * * *'});
  expect(configSchema.safeParse({...env,FINANCIAL_BACKFILL_DELAY_MS:499}).success).toBe(false);
  expect(configSchema.safeParse({...env,FINANCIAL_BACKFILL_DELAY_MS:10001}).success).toBe(false);
});

it('stops the scheduled financial drain across corporations after a rate limit',async()=>{
  state.financialEnabled=true; state.corpId='';
  state.financial.mockResolvedValue({windowsCompleted:0,windowsFailed:1,instancesProcessed:0,rateLimited:true});
  startScheduler(); await state.schedules.find(row=>row.expression==='*/10 * * * *')!.run();
  expect(state.financial).toHaveBeenCalledTimes(1);
  expect(state.financial).toHaveBeenCalledWith({corpId:'first',maxWindows:1,delayMs:2000});
});
