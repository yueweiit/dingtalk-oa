import { describe, expect, it } from 'vitest';
import { normalizeInstance, parseDingTalkTime } from './instance-normalizer.js';
import { approvalInstanceDetailSchema } from '../dingtalk/types.js';

describe('parseDingTalkTime', () => {
  it('treats DingTalk Z timestamps as Asia/Shanghai wall-clock time', () => {
    expect(parseDingTalkTime('2026-09-17T16:28Z')?.toISOString())
      .toBe('2026-09-17T08:28:00.000Z');
  });
});

describe('normalizeInstance participant aliases', () => {
  it('accepts current top-level DingTalk user and department fields', () => {
    const raw = { status: 'RUNNING', originatorUserId: 'user-1', originatorUserName: '发起人',
      originatorDeptId: 12, originatorDeptName: '历史部门' };
    const instance = normalizeInstance('corp-1', approvalInstanceDetailSchema.parse(raw));
    expect(instance).toMatchObject({ originator_user_id: 'user-1', originator_user_name: '发起人',
      originator_dept_id: '12', originator_dept_name: '历史部门' });
    expect(instance.raw_payload).toMatchObject({ originatorUserId: 'user-1' });
  });
  it('does not let blank nested fields hide valid top-level values or event fallbacks', () => {
    const instance = normalizeInstance('corp-1', { status: 'RUNNING', originator: { userId: ' ', name: '', deptName: ' ' },
      originatorUserId: 'top-user', originatorUserName: '姓名', originatorDeptName: '部门' }, { originatorUserId: 'event-user' });
    expect(instance).toMatchObject({ originator_user_id: 'top-user', originator_user_name: '姓名', originator_dept_name: '部门' });
    expect(normalizeInstance('corp-1', { status: 'RUNNING', originatorUserId: '' }, { originatorUserId: 'event-user' }).originator_user_id).toBe('event-user');
  });
  it('does not mix top-level labels with a different nested person or department', () => {
    expect(normalizeInstance('corp-a', { status: 'RUNNING', originator: { userId: 'user-a' },
      originatorUserId: 'user-b', originatorUserName: '其他人', originatorDeptId: '30', originatorDeptName: '其他部门' }))
      .toMatchObject({ originator_user_id: 'user-a', originator_user_name: null, originator_dept_id: null, originator_dept_name: null });
    expect(normalizeInstance('corp-a', { status: 'RUNNING', originator: { userId: 'user-a', deptId: '20' },
      originatorUserId: 'user-a', originatorDeptId: '30', originatorDeptName: '其他部门' }))
      .toMatchObject({ originator_dept_id: '20', originator_dept_name: null });
  });
});
