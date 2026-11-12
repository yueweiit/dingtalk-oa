import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DepartureSource } from '../../normalize/user-departure.js';
import { backfillUserDepartures, syncApprovalDeparture } from './user-departure.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
const client = { query } as unknown as pg.PoolClient;
vi.mock('../pool.js', () => ({
  withClient: (run: (client: pg.PoolClient) => unknown) => run(client),
  withTransaction: (run: (client: pg.PoolClient) => unknown) => run(client),
}));

const detail = {
  status: 'COMPLETED', result: 'agree', originatorUserId: 'hr',
  formComponentValues: [
    { id: 'TextField_6RXTO615OMS0', value: 'Ana Ejemplo' },
    { id: 'TextareaField_1POXA3C2RB9C0', value: 'Ana E.' },
    { id: 'DDDateField_EZMO31OXMUW0', value: '2026-11-20' },
  ],
};
const mexican: DepartureSource = {
  corp_id: 'corp-a', process_instance_id: 'departure-a', process_code: 'PROC-7DB16FD2-70D6-41AE-9C5D-AE3DFF53A957',
  status: 'COMPLETED', result: 'agree', deleted_at: null, originator_user_id: 'old-event-id',
  raw_payload: detail,
};
const confirmedEmployee = {
  user_id: 'reviewed-employee', employee_name: 'Ana Ejemplo', dingtalk_name: 'Ana E.',
  identity_method: 'manual', identity_review_required: false,
};

describe('departure history and identity review', () => {
  beforeEach(() => { query.mockReset().mockResolvedValue({ rows: [] }); });

  it('previews local approved sources without writing and counts unresolved Mexican identities', async () => {
    query.mockResolvedValueOnce({ rows: [mexican] });
    expect(await backfillUserDepartures('corp-a', { instanceId: 'departure-a' })).toEqual({
      scanned: 1, approved: 1, identified: 0, pendingIdentity: 1, candidates: 0, pendingDate: 0, dryRun: true,
    });
    expect(query.mock.calls.every(([sql]) => !/INSERT|UPDATE|DELETE/.test(sql))).toBe(true);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('count(DISTINCT user_id) = 1'),
      ['corp-a', 'Ana Ejemplo', 'Ana E.']);
  });

  it.each([['hr', null], ['historical-name-match', 'historical-name-match']])(
    'treats a snapshot name match for %s as an unconfirmed candidate at most', async (matched, candidate) => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ user_id: matched }] });
    expect(await syncApprovalDeparture(client, mexican)).toMatchObject({
      userId: null, identityMethod: null, departedOn: '2026-11-20', candidateUserId: candidate,
    });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO ding_user_departure'),
      ['corp-a', 'departure-a', mexican.process_code, 'MX', 'Ana Ejemplo', 'Ana E.', '2026-11-20', null, null, candidate, false]);
  });

  it('preserves a previously confirmed employee and requires a single approved source for manual review', async () => {
    query.mockResolvedValueOnce({ rows: [confirmedEmployee] });
    expect(await syncApprovalDeparture(client, mexican)).toMatchObject({ userId: 'reviewed-employee', identityMethod: 'manual' });
    expect(query).toHaveBeenCalledTimes(2);
    await expect(backfillUserDepartures('corp-a', { confirmedUserId: 'employee', dryRun: false }))
      .rejects.toThrow('DEPARTURE_CONFIRMATION_REQUIRES_SINGLE_INSTANCE_AND_APPLY');
    await expect(syncApprovalDeparture(client, { ...mexican, status: 'RUNNING' }, { confirmedUserId: 'employee' }))
      .rejects.toThrow('DEPARTURE_CONFIRMATION_REQUIRES_APPROVED_MX_APPROVAL');
    await expect(syncApprovalDeparture(client, mexican, { confirmedUserId: 'hr' }))
      .rejects.toThrow('DEPARTURE_CONFIRMATION_REQUIRES_MX_EMPLOYEE_IDENTITY');
    await expect(syncApprovalDeparture(client, { ...mexican, raw_payload: { ...detail, result: null } }, { confirmedUserId: 'employee' }))
      .rejects.toThrow('DEPARTURE_CONFIRMATION_REQUIRES_MX_EMPLOYEE_IDENTITY');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('preserves historical names and confirmation when a field is omitted and the other is reformatted', async () => {
    const formComponentValues = [{ ...detail.formComponentValues[0], value: 'ANA  EJEMPLO' }, detail.formComponentValues[2]];
    query.mockResolvedValueOnce({ rows: [confirmedEmployee] });
    expect(await syncApprovalDeparture(client, { ...mexican, raw_payload: { ...detail, formComponentValues } }))
      .toMatchObject({ userId: 'reviewed-employee', identityMethod: 'manual', identityReviewRequired: false });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO ding_user_departure'),
      ['corp-a', 'departure-a', mexican.process_code, 'MX', 'Ana Ejemplo', 'Ana E.', '2026-11-20', 'reviewed-employee', 'manual', null, false]);
  });

  it('retains the original manual confirmation when the employee changes and only reopens it on explicit review', async () => {
    const formComponentValues = [{ ...detail.formComponentValues[0], value: 'Otro empleado' }, detail.formComponentValues[2]];
    const changed = { ...mexican, raw_payload: { ...detail, formComponentValues } };
    query.mockResolvedValueOnce({ rows: [confirmedEmployee] });
    expect(await syncApprovalDeparture(client, changed)).toMatchObject({
      userId: 'reviewed-employee', identityMethod: 'manual', identityReviewRequired: true,
    });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO ding_user_departure'),
      ['corp-a', 'departure-a', mexican.process_code, 'MX', 'Ana Ejemplo', 'Ana E.', '2026-11-20', 'reviewed-employee', 'manual', null, true]);

    const paused = { ...confirmedEmployee, identity_review_required: true };
    query.mockResolvedValueOnce({ rows: [paused] });
    expect(await syncApprovalDeparture(client, mexican)).toMatchObject({ identityReviewRequired: true });
    query.mockResolvedValueOnce({ rows: [paused] });
    expect(await syncApprovalDeparture(client, changed, { confirmedUserId: 'new-employee' })).toMatchObject({
      userId: 'new-employee', identityMethod: 'manual', identityReviewRequired: false,
    });
  });

  it('keeps the historical Chinese name if the raw form later omits it', async () => {
    const chinese = {
      ...mexican, process_code: 'PROC-A917A16C-ADED-42A0-830A-DF20A5880948',
      originator_user_id: 'employee', originator_user_name: '当前姓名',
      raw_payload: { ...detail, originatorUserId: 'employee', formComponentValues: [{ id: 'DDDateField_TQHUCEXTH2O0', value: '2026-11-20' }] },
    };
    query.mockResolvedValueOnce({ rows: [{ employee_name: '历史姓名', user_id: 'employee', identity_method: 'originator' }] });
    await syncApprovalDeparture(client, chinese);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO ding_user_departure'),
      ['corp-a', 'departure-a', chinese.process_code, 'CN', '历史姓名', null, '2026-11-20', 'employee', 'originator', null, false]);
  });
});
