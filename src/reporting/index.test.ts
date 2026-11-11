import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperatingExpenseRoutes } from './index.js';
import { operatingExpenseFields as fields } from './operating-expenses.js';

const path = '/api/v1/reporting/operating-expenses';
const query = 'corpId=corp-1&startMonth=2026-10&endMonth=2026-11';
const token = 'test-operating-expenses-token-0001';
const headers = { authorization: 'Bearer ' + token };
const row = (department: string, id: string, detail: string, amount: string) => ({
  rowValue: [
    { label: '部门', value: department, extendValue: [{ id }] },
    { label: '费用明细Detalle de gastos', value: detail },
    { label: '金额（元）Monto (yuan)', value: amount },
  ],
});
const form = (processInstanceId: string, formComponentValues: unknown) => ({ processInstanceId, formComponentValues });
const applicationDate = { name: '申请日期Fecha de solicitud', value: '2026-11-11' };
let server: ReturnType<typeof Fastify> | undefined;

async function setup(readForms = vi.fn(async () => [] as ReturnType<typeof form>[]), enabled = true) {
  server = Fastify();
  await server.register(createOperatingExpenseRoutes({
    token: enabled ? token : undefined, corpId: 'corp-1', processCode: 'PROC-1', readForms,
  }));
  return { server, readForms };
}

afterEach(async () => { await server?.close(); });

describe('monthly operating expenses', () => {
  it('restricts the credential to its configured enterprise and validates the inclusive range', async () => {
    const { server, readForms } = await setup();
    const fetch = (params: string, auth = headers) => server.inject({ url: path + '?' + params, headers: auth });
    expect((await fetch(query, { authorization: 'Bearer wrong' })).statusCode).toBe(401);
    expect((await fetch(query.replace('corp-1', 'corp-2'))).statusCode).toBe(403);
    for (const badQuery of [
      query.replace('2026-10', '2025-11'),
      query.replace('2026-10', '2026-12'),
      query.replace('2026-10', '2026-00'),
      query + '&processCode=OTHER',
    ]) {
      expect((await fetch(badQuery)).statusCode).toBe(400);
    }
    expect(readForms).not.toHaveBeenCalled();
  });

  it('counts approved source forms once per group and uses the expense month for late submissions', async () => {
    const { server, readForms } = await setup(vi.fn(async () => [
      form('office', [
        applicationDate, { name: fields.management, value: fields.office },
        { id: 'TableField_9KUR3Y1BQYW0', value: JSON.stringify([
          row('拉丁购', '1089990115', '租金Alquiler', '3470.77'),
          row('拉丁购', '1089990115', '电费Electricidad', '736.47'),
          row('拉丁购', '1089990115', '物业费', '100'),
          row('其他部门', 'other', '租金Alquiler', '100'),
        ]) },
      ]),
      form('salary', [
        applicationDate, { name: fields.management, value: fields.salary },
        { label: '明细Detalle', value: [row('店铺 A', 'one', '', '1200.50'), row('店铺 A', 'one', '', '99.50')] },
      ]),
      form('late-shared', [
        { name: '申请日期Fecha de solicitud', value: '2027-01-03' },
        { name: fields.sharedAdmin, value: '1,217.33' },
        { name: '费用所属月份', value: '2026-10-31' },
        { label: '明细', value: [row('店铺 A', 'one', '', '0'), row('店铺 A', 'one', '', '0'), row('店铺 B', 'two', '', '0')] },
      ]),
      form('description-shared', [
        { label: fields.sharedAdmin, value: '-0.13' },
        { name: '事项说明Explicación de asuntos', value: '2026年10月费用，归到2026年10月份' },
        { name: '明细', value: [row('店铺 A', 'one', '', '0')] },
      ]),
      form('bad-month', [
        { name: fields.sharedAdmin, value: '100' },
        { name: '费用所属月份', value: '2026-02-30' },
        { name: '事项说明', value: '2026年10月份' },
        { name: '明细', value: [row('店铺 A', 'one', '', '0'), row('店铺 A', 'one', '', '0')] },
      ]),
    ]));
    const response = await server.inject({ url: path + '?' + query, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(readForms).toHaveBeenCalledOnce();
    expect(readForms).toHaveBeenCalledWith('corp-1', 'PROC-1');
    expect(response.json()).toEqual({
      success: true, corpId: 'corp-1', startMonth: '2026-10', endMonth: '2026-11',
      data: [
        { expenseType: 'china_salary', month: '2026-11', departmentName: '店铺 A', amount: '1300.00', currency: 'CNY', approvalCount: 1 },
        { expenseType: 'office_space', month: '2026-11', departmentName: null, amount: '4207.24', currency: 'CNY', approvalCount: 1 },
        { expenseType: 'shared_admin', month: '2026-10', departmentName: '店铺 A', amount: '1217.20', currency: 'CNY', approvalCount: 2 },
        { expenseType: 'shared_admin', month: '2026-10', departmentName: '店铺 B', amount: '1217.33', currency: 'CNY', approvalCount: 1 },
      ],
      warnings: [{ code: 'EXPENSE_MONTH_UNRESOLVED', expenseType: 'shared_admin', processInstanceId: 'bad-month', departmentNames: ['店铺 A'] }],
    });
  });

  it('fails closed when disabled', async () => {
    const { server, readForms } = await setup(undefined, false);
    const response = await server.inject({ url: path + '?' + query, headers });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('OPERATING_EXPENSE_API_DISABLED');
    expect(readForms).not.toHaveBeenCalled();
  });

  it('reports late salary and shared management fees in the stated month', async () => {
    const salary = { name: fields.management, value: fields.salary };
    const detail = { label: '明细detalle', value: [row('店铺 A', 'one', '', '5,477.25'), row('店铺 B', 'two', '', '5,849.28')] };
    const { server } = await setup(vi.fn(async () => [
      form('november-submission', [
        applicationDate, salary, detail,
        { name: fields.sharedAdmin, value: '1,217.33' },
        { name: '事项说明Explicación de asuntos', value: '1.2026年10月测试店铺薪资共11326.53元。2.10月份补缴差额。' },
      ]),
      form('explicit-priority', [
        applicationDate, salary,
        { name: '费用所属月份', value: '2026-10' },
        { name: '事项说明', value: '参照2026年9月薪资' },
        { label: '明细', value: [row('店铺 C', 'three', '', '10.00')] },
      ]),
      form('conflicting-months', [
        applicationDate, salary,
        { name: '事项说明', value: '2026年10月工资和2026年11月工资' },
        { label: '明细', value: [row('店铺 C', 'three', '', '300.00')] },
      ]),
    ]));

    const october = await server.inject({ url: path + '?' + query.replace('endMonth=2026-11', 'endMonth=2026-10'), headers });
    expect(october.statusCode).toBe(200);
    expect(october.json().data).toEqual([
      ['china_salary', '2026-10', '店铺 A', '5477.25'],
      ['china_salary', '2026-10', '店铺 B', '5849.28'],
      ['china_salary', '2026-10', '店铺 C', '10.00'],
      ['shared_admin', '2026-10', '店铺 A', '1217.33'],
      ['shared_admin', '2026-10', '店铺 B', '1217.33'],
    ].map(([expenseType, month, departmentName, amount]) =>
      ({ expenseType, month, departmentName, amount, currency: 'CNY', approvalCount: 1 })));
    const november = await server.inject({ url: path + '?' + query.replace('startMonth=2026-10', 'startMonth=2026-11'), headers });
    expect(november.statusCode).toBe(200);
    expect(november.json().data).toEqual([]);
    expect(november.json().warnings).toEqual([{
      code: 'APPLICATION_MONTH_UNRESOLVED', expenseType: 'china_salary',
      processInstanceId: 'conflicting-months', departmentNames: ['店铺 C'],
    }]);
  });

  it('ignores reference months and recognizes a stated payroll month alongside a reference', async () => {
    const salary = { name: fields.management, value: fields.salary };
    const sharedAdmin = { name: fields.sharedAdmin, value: '30.00' };
    const detail = (department: string) => ({ label: '明细', value: [row(department, 'one', '', '100.00')] });
    const { server } = await setup(vi.fn(async () => [
      form('reference-only', [
        applicationDate, salary, sharedAdmin, detail('店铺 A'),
        { name: '事项说明', value: '本月工资，参考2026年9月审批的工资标准。' },
      ]),
      form('salary-standard', [
        applicationDate, salary, detail('店铺 B'),
        { name: '事项说明', value: '2026年9月工资标准继续执行，本月发放。' },
      ]),
      form('stated-payroll-month', [
        applicationDate, salary, sharedAdmin, detail('店铺 C'),
        { name: '事项说明', value: '2026年10月工资参考2026年9月审批的标准。' },
      ]),
      form('past-payroll-as-reference', [
        applicationDate, salary, detail('店铺 D'),
        { name: '事项说明', value: '2026年9月工资作为本月参考，本月工资按新标准发放。' },
      ]),
    ]));
    const response = await server.inject({ url: path + '?' + query.replace('startMonth=2026-10', 'startMonth=2026-09'), headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      ['china_salary', '2026-10', '店铺 C', '100.00'],
      ['china_salary', '2026-11', '店铺 A', '100.00'],
      ['china_salary', '2026-11', '店铺 B', '100.00'],
      ['china_salary', '2026-11', '店铺 D', '100.00'],
      ['shared_admin', '2026-10', '店铺 C', '30.00'],
    ].map(([expenseType, month, departmentName, amount]) =>
      ({ expenseType, month, departmentName, amount, currency: 'CNY', approvalCount: 1 })));
    expect(response.json().warnings).toEqual([{
      code: 'EXPENSE_MONTH_UNRESOLVED', expenseType: 'shared_admin',
      processInstanceId: 'reference-only', departmentNames: ['店铺 A'],
    }]);
  });

  it('keeps month conflict warnings within ranges their candidates could affect', async () => {
    const payroll = [
      { name: fields.management, value: fields.salary },
      { name: fields.sharedAdmin, value: '30.00' },
      { label: '明细', value: [row('店铺 A', 'one', '', '100.00')] },
    ];
    const monthField = (value: string) => ({ name: '费用所属月份', value });
    const { server } = await setup(vi.fn(async () => [
      form('historical-description', [
        ...payroll, { ...applicationDate, value: '2024-11-11' },
        { name: '事项说明', value: '2024年9月和2024年10月工资。' },
      ]),
      form('historical-explicit', [...payroll, applicationDate, monthField('2024-09'), monthField('2024-10')]),
      form('overlapping-conflict', [...payroll, applicationDate, monthField('2024-09'), monthField('2026-10')]),
      form('unknown-month', [...payroll, applicationDate, monthField('2024-09'), monthField('待确认')]),
    ]));
    const response = await server.inject({ url: path + '?' + query, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
    expect(response.json().warnings).toEqual(['overlapping-conflict', 'unknown-month'].flatMap(processInstanceId => [
      { code: 'APPLICATION_MONTH_UNRESOLVED', expenseType: 'china_salary', processInstanceId, departmentNames: ['店铺 A'] },
      { code: 'EXPENSE_MONTH_UNRESOLVED', expenseType: 'shared_admin', processInstanceId, departmentNames: ['店铺 A'] },
    ]));
  });

  it('keeps valid approvals readable when legacy application dates are ambiguous or invalid', async () => {
    const dateFields = (...values: string[]) => values.map(value => ({ ...applicationDate, value }));
    const salary = { name: fields.management, value: fields.salary };
    const detail = { label: '明细', value: [row('店铺 A', 'one', '', '100.00')] };
    const { server } = await setup(vi.fn(async () => [
      form('historical', [...dateFields('2025-01-10', '2025-02-10'), salary, detail]),
      form('historical-invalid-day', [...dateFields('2025-02-30'), salary, detail]),
      form('valid-compact', [...dateFields('20261111'), salary, detail]),
      form('conflicting-in-range', [...dateFields('2026-10-11', '2026-11-11'), salary, detail]),
      form('invalid-in-range', [...dateFields('2026-11-31'), salary, detail]),
    ]));
    const response = await server.inject({ url: path + '?' + query, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      { expenseType: 'china_salary', month: '2026-11', departmentName: '店铺 A',
        amount: '100.00', currency: 'CNY', approvalCount: 1 },
    ]);
    expect(response.json().warnings).toEqual(['conflicting-in-range', 'invalid-in-range'].map(processInstanceId => ({
      code: 'APPLICATION_MONTH_UNRESOLVED', expenseType: 'china_salary', processInstanceId, departmentNames: ['店铺 A'],
    })));
  });

  it('excludes explicitly foreign amounts, using currency evidence from the selected amount first', async () => {
    const salary = { name: fields.management, value: fields.salary };
    const expenseRow = (department: string, label: string, value: string, currency?: string) => ({ rowValue: [
      { label: '部门', value: department }, { label, value },
      ...(currency ? [{ label: '币种Moneda', value: currency }] : []),
    ] });
    const formCurrency = { name: '币种Moneda', value: '墨西哥比索MXN' };
    const { server } = await setup(vi.fn(async () => [
      form('salary-mixed', [
        applicationDate, salary, formCurrency,
        { label: '明细', value: [
          expenseRow('店铺 A', '金额（MXN）', '100.00'),
          expenseRow('店铺 A', '金额（CNY）', '20.10'),
          expenseRow('店铺 B', '金额', '700.00'),
          expenseRow('店铺 C', '金额', '40.01', '人民币RMB'),
          expenseRow('店铺 D', '金额（元）', '50.00', 'USD'),
        ] },
      ]),
      form('shared-foreign', [
        { name: '费用所属月份', value: '2026-10' },
        { name: fields.sharedAdmin, value: '200', currency: 'USD' },
        { label: '明细', value: [expenseRow('店铺 A', '金额', '200')] },
      ]),
      form('office-local', [
        applicationDate, { name: fields.management, value: fields.office }, formCurrency,
        { id: 'TableField_9KUR3Y1BQYW0', value: [row('拉丁购', '1089990115', '租金Alquiler', '10')] },
      ]),
    ]));
    const response = await server.inject({ url: path + '?' + query, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      { expenseType: 'china_salary', month: '2026-11', departmentName: '店铺 A', amount: '20.10', currency: 'CNY', approvalCount: 1 },
      { expenseType: 'china_salary', month: '2026-11', departmentName: '店铺 C', amount: '40.01', currency: 'CNY', approvalCount: 1 },
      { expenseType: 'office_space', month: '2026-11', departmentName: null, amount: '10', currency: 'CNY', approvalCount: 1 },
    ]);
    expect(response.json().warnings).toEqual([
      { code: 'EXPENSE_CURRENCY_UNSUPPORTED', expenseType: 'china_salary', processInstanceId: 'salary-mixed',
        departmentNames: ['店铺 A', '店铺 B', '店铺 D'], month: '2026-11' },
      { code: 'EXPENSE_CURRENCY_UNSUPPORTED', expenseType: 'shared_admin', processInstanceId: 'shared-foreign',
        departmentNames: ['店铺 A'], month: '2026-10' },
    ]);
  });

  it('reports a read failure without returning amounts or an internal error', async () => {
    const { server } = await setup(vi.fn(async () => { throw new Error('database detail'); }));
    const response = await server.inject({ url: path + '?' + query, headers });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ success: false, code: 'OPERATING_EXPENSE_READ_UNAVAILABLE' });
  });
});
