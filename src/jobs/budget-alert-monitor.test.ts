import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractBudgetAlertInput,
  extractBudgetAlertInputs,
  monitorBudgetAlertForInstance,
  type BudgetAlertFieldMap,
} from './budget-alert-monitor.js';

const { config } = vi.hoisted(() => ({
  config: {
    BUDGET_ALERT_PROCESS_CODES: 'PROC-CA8104B8-341A-4B2C-92AA-8091C08BA11B',
    BUDGET_ALERT_FIELD_MAP: '',
    BUDGET_ALERT_API_KEY: 'test-key',
    DINGTALK_ALERT_RECIPIENT_USER_IDS: 'receiver-1',
  },
}));

vi.mock('../config/index.js', () => ({
  getConfig: () => config,
}));

const fieldMap: BudgetAlertFieldMap = {
  applicationDateFieldId: 'DDDateField_B0K470VSL0O0',
  budgetTypeFieldId: 'DDSelectField_14ZWYSLFU1400',
  serviceEntityFieldId: 'CascadeField_G8SEQLCWG1S0',
  amountFieldId: 'MoneyField_1FPZGEQOZ4M80',
  splits: [],
};

const detail = {
  processInstanceId: 'instance-128623',
  processCode: 'PROC-CA8104B8-341A-4B2C-92AA-8091C08BA11B',
  status: 'RUNNING',
  title: '采购支出',
  formComponentValues: [
    { id: 'DDDateField_B0K470VSL0O0', value: '2026-09-17' },
    { id: 'DDSelectField_14ZWYSLFU1400', value: '非生产No producción', extValue: '{"key":"option_1"}' },
    { id: 'CascadeField_G8SEQLCWG1S0', value: '悦为智能 YW Tech_AI', extValue: '{"code":"1077343081","name":"悦为智能 YW Tech_AI"}' },
    { id: 'MoneyField_1FPZGEQOZ4M80', value: '123123' },
  ],
};

const processCode = 'PROC-CA8104B8-341A-4B2C-92AA-8091C08BA11B';
const fieldMapJson = (map: BudgetAlertFieldMap) => JSON.stringify({ [processCode]: map });

beforeEach(() => {
  config.BUDGET_ALERT_FIELD_MAP = fieldMapJson(fieldMap);
});

describe('budget alert monitor', () => {
  it('does not claim a delivery when the instance ID is missing', async () => {
    const claimDelivery = vi.fn();

    await expect(monitorBudgetAlertForInstance('corp-1', {
      ...detail,
      processInstanceId: undefined,
    }, {
      fetchSnapshot: vi.fn(),
      claimDelivery,
      markSent: vi.fn(),
      markFailed: vi.fn(),
      send: vi.fn(),
    })).resolves.toEqual({ status: 'skipped', sent: 0, reason: 'instance_id_missing' });

    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('extracts the submitted instance fields by component ID', () => {
    expect(extractBudgetAlertInput(detail, fieldMap)).toEqual({
      input: {
        departmentId: '1077343081',
        serviceEntityName: '悦为智能 YW Tech_AI',
        month: '2026-09',
        budgetType: 'option_1',
        applicationAmount: 123123,
        source: 'service_entity',
      },
    });
  });

  it('sends an over-budget alert once using an instance delivery key', async () => {
    const claimDelivery = vi.fn().mockResolvedValue(true);
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await monitorBudgetAlertForInstance('corp-1', detail, {
      fetchSnapshot: vi.fn().mockResolvedValue({
        departmentId: '1077343081', month: '2026-09', budgetAmount: 101155, usedAmount: 0,
        applicationAmount: 123123, projectedAmount: 123123, utilizationRate: 1.217174, alertLevel: 'over_budget',
      }),
      claimDelivery,
      markSent: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      send,
    });

    expect(result).toEqual({ status: 'over_budget', sent: 1 });
    expect(claimDelivery).toHaveBeenCalledWith(expect.objectContaining({
      alertType: 'budget_threshold',
      alertPhase: 'over_budget:1077343081:2026-09',
      recipientUserId: 'receiver-1',
    }), expect.any(Object));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('skips a non-empty unconfigured split table', () => {
    const splitDetail = {
      ...detail,
      formComponentValues: [...detail.formComponentValues, {
        id: 'TableField_EXAMPLE', componentType: 'TableField', value: '[{"amount":"20"}]',
      }],
    };
    expect(extractBudgetAlertInput(splitDetail, fieldMap)).toEqual({ reason: 'unconfigured_split_table' });
  });

  it('merges split rows by stable department ID instead of using the service entity', () => {
    const splitMap: BudgetAlertFieldMap = {
      ...fieldMap,
      splits: [{
        tableFieldId: 'TableField_SPLIT',
        departmentFieldId: 'DepartmentField_DEPT',
        amountFieldId: 'MoneyField_AMOUNT',
      }],
    };
    const splitDetail = {
      ...detail,
      formComponentValues: [...detail.formComponentValues, {
        id: 'TableField_SPLIT',
        componentType: 'TableField',
        value: '',
        details: [
          { rowValue: [
            { id: 'DepartmentField_DEPT', value: '技术部', extValue: '{"id":"dept-1","name":"技术部"}' },
            { id: 'MoneyField_AMOUNT', value: '1,168' },
          ] },
          { rowValue: [
            { id: 'DepartmentField_DEPT', value: '技术部', extValue: '{"id":"dept-1","name":"技术部"}' },
            { id: 'MoneyField_AMOUNT', value: '32' },
          ] },
          { rowValue: [
            { id: 'DepartmentField_DEPT', value: '产品部', extValue: '{"deptId":"dept-2","name":"产品部"}' },
            { id: 'MoneyField_AMOUNT', value: '1,050' },
          ] },
        ],
      }],
    };

    expect(extractBudgetAlertInputs(splitDetail, splitMap)).toEqual({
      inputs: [
        {
          departmentId: 'dept-1', serviceEntityName: '技术部', month: '2026-09',
          budgetType: 'option_1', applicationAmount: 1200, source: 'department_split',
        },
        {
          departmentId: 'dept-2', serviceEntityName: '产品部', month: '2026-09',
          budgetType: 'option_1', applicationAmount: 1050, source: 'department_split',
        },
      ],
    });
  });

  it('queries each split department, skips zero budget, and sends a 90 percent warning', async () => {
    const splitMap: BudgetAlertFieldMap = {
      ...fieldMap,
      splits: [{
        tableFieldId: 'TableField_SPLIT',
        departmentFieldId: 'DepartmentField_DEPT',
        amountFieldId: 'MoneyField_AMOUNT',
      }],
    };
    config.BUDGET_ALERT_FIELD_MAP = fieldMapJson(splitMap);
    const splitDetail = {
      ...detail,
      formComponentValues: [...detail.formComponentValues, {
        id: 'TableField_SPLIT', componentType: 'TableField', value: JSON.stringify([
          [{ id: 'DepartmentField_DEPT', value: '无预算部门', extValue: '{"id":"dept-zero"}' }, { id: 'MoneyField_AMOUNT', value: '100' }],
          [{ id: 'DepartmentField_DEPT', value: '预警部门', extValue: '{"id":"dept-warning"}' }, { id: 'MoneyField_AMOUNT', value: '200' }],
        ]),
      }],
    };
    const fetchSnapshot = vi.fn().mockImplementation(async (input) => input.departmentId === 'dept-zero'
      ? {
          departmentId: input.departmentId, month: input.month, budgetAmount: 0, usedAmount: 0,
          applicationAmount: input.applicationAmount, projectedAmount: input.applicationAmount,
          utilizationRate: null, alertLevel: 'missing_budget',
        }
      : {
          departmentId: input.departmentId, month: input.month, budgetAmount: 1000, usedAmount: 700,
          applicationAmount: input.applicationAmount, projectedAmount: 900,
          utilizationRate: 0.9, alertLevel: 'warning_90',
        });
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await monitorBudgetAlertForInstance('corp-1', splitDetail, {
      fetchSnapshot,
      claimDelivery: vi.fn().mockResolvedValue(true),
      markSent: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      send,
    });

    expect(result).toEqual({ status: 'warning_90', sent: 1 });
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain('部门：预警部门');
  });

  it('rejects a positive split row without a stable department ID', () => {
    const splitMap: BudgetAlertFieldMap = {
      ...fieldMap,
      splits: [{ tableFieldId: 'TableField_SPLIT', departmentFieldId: 'DepartmentField_DEPT', amountFieldId: 'MoneyField_AMOUNT' }],
    };
    const splitDetail = {
      ...detail,
      formComponentValues: [...detail.formComponentValues, {
        id: 'TableField_SPLIT', componentType: 'TableField', value: JSON.stringify([[
          { id: 'DepartmentField_DEPT', value: '只有名称的部门' },
          { id: 'MoneyField_AMOUNT', value: '100' },
        ]]),
      }],
    };
    expect(extractBudgetAlertInputs(splitDetail, splitMap)).toEqual({ reason: 'split_department_id_missing' });
  });
});
