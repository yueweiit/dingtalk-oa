import { describe, expect, it } from 'vitest';
import { departureFromApproval, type DepartureSource } from './user-departure.js';

const cnFields = [
  { id: 'TextField_SGOO4D848XC0', value: '历史姓名' },
  { id: 'DDDateField_1KC9Y4IGMK74', value: '2026-10-01' },
  { id: 'DDDateField_TQHUCEXTH2O0', value: '2026-11-30' },
];
const cnDetail = { status: 'COMPLETED', result: 'agree', originatorUserId: '001', formComponentValues: cnFields };
const chinese: DepartureSource = {
  corp_id: 'corp-a', process_instance_id: 'approval-a', process_code: 'PROC-A917A16C-ADED-42A0-830A-DF20A5880948',
  status: 'COMPLETED', result: 'agree', deleted_at: null,
  originator_user_id: '001', raw_payload: cnDetail,
};

describe('departure approval normalization', () => {
  it('preserves the Chinese employee name and confirmed originator, using the approved departure date', () => {
    expect(departureFromApproval(chinese)).toMatchObject({
      region: 'CN', submitterId: '001', employeeName: '历史姓名', dingtalkName: null, departedOn: '2026-11-30',
    });
  });

  it('uses the original Chinese originator if the historical column is missing or holds an event fallback', () => {
    expect(departureFromApproval({ ...chinese, originator_user_id: null })).toMatchObject({ submitterId: '001' });
    expect(departureFromApproval({ ...chinese, originator_user_id: 'other' })).toMatchObject({ submitterId: '001' });
    expect(departureFromApproval({ ...chinese, raw_payload: {} })).toMatchObject({ submitterId: null });
  });

  it('keeps contradictory original submitter IDs pending and accepts duplicate aliases of the same ID', () => {
    expect(departureFromApproval({ ...chinese, raw_payload: { ...cnDetail, originator: { userId: 'other' } } }))
      .toMatchObject({ submitterId: null, submitterIds: ['other', '001'] });
    expect(departureFromApproval({ ...chinese, raw_payload: { ...cnDetail, originator: { userId: '001' }, originatorId: ' 001 ' } }))
      .toMatchObject({ submitterId: '001', submitterIds: ['001'] });
  });

  it('uses the original submitter name when available and never copies an already enriched name into a departure', () => {
    const archived = {
      ...chinese, originator_user_name: '另一张离职单补齐的姓名', originator_user_name_source_instance_id: 'other-departure',
      raw_payload: { ...cnDetail, formComponentValues: [cnFields[2]] },
    };
    expect(departureFromApproval(archived)).toMatchObject({ employeeName: null });
    expect(departureFromApproval({ ...archived, raw_payload: { ...archived.raw_payload, originatorUserName: '原始发起人姓名' } }))
      .toMatchObject({ employeeName: '原始发起人姓名' });
  });

  it('extracts the Mexican employee and actual date separately from the submitting account', () => {
    expect(departureFromApproval({
      ...chinese, process_code: 'PROC-7DB16FD2-70D6-41AE-9C5D-AE3DFF53A957',
      raw_payload: { ...cnDetail, formComponentValues: [
        { id: 'TextField_6RXTO615OMS0', value: 'Nombre completo' },
        { id: 'TextareaField_1POXA3C2RB9C0', value: 'Nombre DingTalk' },
        { id: 'DDDateField_1DM3O45JLLSW0', value: '2026-12-01' },
        { id: 'DDDateField_EZMO31OXMUW0', value: '2026-11-30' },
      ] },
    })).toMatchObject({
      region: 'MX', submitterId: '001', employeeName: 'Nombre completo', dingtalkName: 'Nombre DingTalk', departedOn: '2026-11-30',
    });
  });

  it.each([
    { status: 'RUNNING' }, { status: 'TERMINATED' }, { result: 'refuse' },
    { deleted_at: new Date() }, { process_code: 'unrelated' },
  ])('ignores an ineligible source %j', overrides => {
    expect(departureFromApproval({ ...chinese, ...overrides })).toBeNull();
  });

  it('ignores merged dates unless the same original detail contains an approval and a valid departure date', () => {
    const archived = { ...chinese, form_component_values: cnFields };
    const { formComponentValues: _omitted, ...withoutForm } = cnDetail;
    for (const raw_payload of [withoutForm, { ...cnDetail, result: null }, { ...cnDetail, status: 'RUNNING' }]) {
      expect(departureFromApproval({ ...archived, raw_payload })).toMatchObject({ departedOn: null });
    }
    const corrected = { ...cnDetail, formComponentValues: [{ ...cnFields[2], value: '2026-12-01' }] };
    expect(departureFromApproval({ ...archived, raw_payload: corrected })).toMatchObject({ departedOn: '2026-12-01' });
  });

  it('leaves missing, duplicate, and impossible departure dates pending', () => {
    const field = { id: 'DDDateField_TQHUCEXTH2O0', value: '2026-02-29' };
    for (const components of [[], [field], [field, { ...field, value: '2026-11-30' }]]) {
      expect(departureFromApproval({ ...chinese, raw_payload: { ...cnDetail, formComponentValues: components } }))
        .toMatchObject({ departedOn: null });
    }
  });
});
