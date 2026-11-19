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
  it('attributes tax to the previous month and housing fund to the submission month, once per department', async () => {
    const tax = [{ name: fields.management, value: '税费Impuestos' }, { name: '税费Impuestos', value: '薪资税/个税Renta' }];
    const fund = { name: fields.management, value: '社保公积金seguridad social y fondo de vivienda' };
    const fundTable = { id: 'TableField_G2ELEALN0S80', value: [ { rowValue: [
      { label: '部门', value: '店铺 A' }, { key: 'MoneyField_6TQM4CNAHYO0', label: '社保+公积金（个人）', value: '900' },
      { key: 'MoneyField_X5KBWAODJ1S0', label: '总金额（元）', value: '1023.10' },
      { key: 'MoneyField_IR71DYOSO8O0', label: '社保+公积金（公司）SS + Vivienda (Emp.)', value: '123.10' },
    ] } ] };
    const generic = { name: '明细detalle', value: JSON.stringify([row('店铺 A', 'one', '', '999.99')]) };
    const approvals = [
      { ...form('tax', [...tax, applicationDate, { name: '费用所属月份', value: '2027-01' }, generic,
        { name: '薪酬税费总支出(分部门)', details: [
          [{ id: 'DepartmentField_D', value: '店铺 A' }, { id: 'MoneyField_T', value: '30.99' }],
          [{ id: 'DepartmentField_D', value: '店铺 A' }, { id: 'MoneyField_T', value: '-0.09' }],
          [{ id: 'DepartmentField_D', value: '店铺 B' }, { id: 'MoneyField_T', value: '91' }],
        ] }] ), submittedMonth: '2027-01' },
      { ...form('tax-generic', [...tax, { name: '薪酬税费总支出', value: [{ rowValue: [] }] },
        { ...generic, value: [row('店铺 A', 'one', '', '2.01')] }]), submittedMonth: '2027-01' },
      { ...form('fund', [fund, fundTable, generic, { name: '费用所属月份', value: '2026-11' }]), submittedMonth: '2026-12' },
      { ...form('jan-fund', [fund, fundTable]), submittedMonth: '2027-01' },
      { ...form('nov-tax', [...tax, generic]), submittedMonth: '2026-11' },
      { ...form('not-tax', [{ name: '税费Impuestos', value: '企业所得税' }, { name: '事项说明', value: '个税' }, generic]), submittedMonth: '2027-01' },
    ];
    const { server, readForms } = await setup(vi.fn(async () => approvals));
    const december = '?corpId=corp-1&startMonth=2026-12&endMonth=2026-12';
    expect((await server.inject({ url: path + december, headers })).json().data).toEqual([]);
    const response = (await server.inject({ url: path + december + '&includePayroll=1', headers })).json();
    expect(readForms).toHaveBeenLastCalledWith('corp-1', 'PROC-1', { startMonth: '2026-12', endMonth: '2026-12' });
    expect(response.warnings).toEqual([]);
    expect(response.data).toEqual([
      { expenseType: 'employer_contributions', month: '2026-12', departmentName: '店铺 A', amount: '123.10', currency: 'CNY', approvalCount: 1 },
      { expenseType: 'individual_income_tax', month: '2026-12', departmentName: '店铺 A', amount: '32.91', currency: 'CNY', approvalCount: 2 },
      { expenseType: 'individual_income_tax', month: '2026-12', departmentName: '店铺 B', amount: '91', currency: 'CNY', approvalCount: 1 },
    ]);
  });

  it('scopes uncertain payroll details to their stores and excludes employee contributions and foreign amounts', async () => {
    const fund = { name: fields.management, value: '社保公积金' };
    const detail = (shop: string, column: string, value: string, currency = 'CNY') => ({ rowValue: [
      { label: '部门', value: shop }, { label: column, value, currency },
    ] });
    const forms = [
      { ...form('fund', [fund, { id: 'TableField_G2ELEALN0S80', value: [
        detail('店铺 A', '社保+公积金（公司）', '30.80'), detail('店铺 B', '社保+公积金（个人）', '100'),
        detail('店铺 B', '总金额（元）', '120'), detail('店铺 C', '社保+公积金（公司）', '10', 'MXN'),
        detail('店铺 D', '社保+公积金（公司）', '待核对'),
        detail('店铺 D', '社保+公积金（公司）', '1e101'),
      ] }]), submittedMonth: '2026-10' },
      form('unknown-date', [{ name: '税费Impuestos', value: '个税' }, { name: '明细', value: [row('店铺 A', 'one', '', '99')] }]),
    ];
    const { server } = await setup(vi.fn(async () => forms));
    const response = (await server.inject({ url: path + '?' + query + '&includePayroll=1', headers })).json();
    expect(response.data).toEqual([{ expenseType: 'employer_contributions', month: '2026-10', departmentName: '店铺 A', amount: '30.80', currency: 'CNY', approvalCount: 1 }]);
    expect(response.warnings).toEqual([
      { code: 'EXPENSE_CURRENCY_UNSUPPORTED', month: '2026-10', expenseType: 'employer_contributions', departmentNames: ['店铺 C'], processInstanceId: 'fund' },
      { code: 'PAYROLL_DETAIL_UNRESOLVED', month: '2026-10', expenseType: 'employer_contributions', departmentNames: ['店铺 B', '店铺 D'], processInstanceId: 'fund' },
      { code: 'APPLICATION_MONTH_UNRESOLVED', expenseType: 'individual_income_tax', departmentNames: ['店铺 A'], processInstanceId: 'unknown-date' },
    ]);
  });

  it('resolves a single store, counts mirrored rows once and keeps valid payroll beside malformed rows', async () => {
    const ids = [{ id: '1', name: '店 A' }, { id: '2', name: '店 B' }];
    const cells = (department: unknown, amount: unknown, metadata = {}) => [
      { id: 'DepartmentField_store', value: department, ...metadata }, { id: 'MoneyField_tax', value: amount },
    ];
    const tax = (id: string, value: unknown, details?: unknown, dedicated?: unknown) => ({
      ...form(id, [{ name: '税费Impuestos', value: '个税' },
        { name: '明细detalle', value: JSON.stringify(value), details },
        ...(dedicated ? [{ name: '薪酬税费总支出', value: [{ rowValue: dedicated }] }] : []),
      ]), submittedMonth: '2026-11',
    });
    const approvals = [
      tax('single', [{ values: cells(JSON.stringify(ids.slice(0, 1)), '100', { extendValue: [ids[0]] }) }]),
      tax('ids', [{ rowValue: [], value: cells('2', '20', { extValue: JSON.stringify(ids[1]) }) }]),
      tax('ambiguous', [{ rowValue: cells('', '700', { extendValue: ids }) }]),
      tax('id-only', [{ rowValue: cells('999', '400') }]),
      tax('conflict', [{ rowValue: cells('店 A', '800', { extValue: ids[1] }) }]),
      tax('mirrors', [{ rowValue: cells('店 A', null) }, { rowValue: cells('店 B', '5') }],
        [{ value: cells('店 A', '4') }, { values: cells('店 B', null) }]),
      tax('twice-in-one-store', { rows: [{ values: cells('店 A', '1') }, { value: cells('店 A', '1') }] },
        [cells('店 A', '1'), cells('店 A', '1')]),
      tax('fallback', [{ rowValue: cells('店 A', '10') }], undefined, cells('[]', '0.00')),
      tax('real-zero', [{ rowValue: cells('店 A', '99') }], undefined, cells('店 B', 0)),
      tax('no-shop', [{ rowValue: cells('店 A', '99') }], undefined, cells('', '77')),
      tax('precision', [{ rowValue: cells('店 A', '1e101') }, { rowValue: cells('店 A', '0.50') },
        { rowValue: cells('店 B', 9007199254740992) }]),
    ];
    const { server } = await setup(vi.fn(async () => approvals));
    const reply = await server.inject({ url: path + '?' + query + '&includePayroll=1', headers });
    expect(reply.statusCode).toBe(200);
    const { data, warnings } = reply.json();
    expect(data).toEqual([
      { month: '2026-10', expenseType: 'individual_income_tax', departmentName: '店 A', currency: 'CNY', amount: '116.50', approvalCount: 5 },
      { month: '2026-10', expenseType: 'individual_income_tax', departmentName: '店 B', currency: 'CNY', amount: '25', approvalCount: 3 },
    ]);
    expect(warnings).toEqual(['ambiguous', 'id-only', 'conflict', 'no-shop', 'precision'].map(processInstanceId => ({
      processInstanceId, month: '2026-10', expenseType: 'individual_income_tax', code: 'PAYROLL_DETAIL_UNRESOLVED',
      departmentNames: processInstanceId === 'precision' ? ['店 A', '店 B'] : [],
    })));
  });

  it('matches reordered rows by number and preserves currency without guessing between duplicate departments', async () => {
    const detail = (value: string | null, rowNumber?: number, metadata = {}) => ({
      rowNumber, values: [{ label: '部门', value: '店 A' }, { label: '金额', value, ...metadata }],
    });
    const tax = (id: string, rows: unknown[], details?: unknown[]) => ({
      ...form(id, [{ name: '税费', value: '个税' }, { name: '明细', value: { rows }, details }]),
      submittedMonth: '2026-11',
    });
    const { server } = await setup(vi.fn(async () => [
      tax('ordered', [detail('3', 2), detail('8', 1)], [detail('8', 1), detail(null, 2)]),
      tax('unpaired', [detail('10'), detail('20')], [detail('10'), detail(null)]),
      tax('old-only', [detail('2')]),
      tax('currency', [detail('40', undefined, { currency: 'USD' })], [detail('40')]),
    ]));
    const response = await server.inject({ url: path + '?' + query + '&includePayroll=1', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([{
      expenseType: 'individual_income_tax', month: '2026-10', departmentName: '店 A', amount: '23', currency: 'CNY', approvalCount: 3,
    }]);
    expect(response.json().warnings).toEqual([
      { expenseType: 'individual_income_tax', month: '2026-10', processInstanceId: 'unpaired', code: 'PAYROLL_DETAIL_UNRESOLVED', departmentNames: ['店 A'] },
      { expenseType: 'individual_income_tax', month: '2026-10', processInstanceId: 'currency', code: 'EXPENSE_CURRENCY_UNSUPPORTED', departmentNames: ['店 A'] },
    ]);
  });

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
      query + '&includePayroll=2',
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
    expect(readForms).toHaveBeenCalledWith('corp-1', 'PROC-1', undefined);
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
