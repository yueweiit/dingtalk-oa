import { describe, expect, it, vi } from 'vitest';
import {
  extractBudgetAlertInput,
  monitorBudgetAlertForInstance,
  type BudgetAlertFieldMap,
} from './budget-alert-monitor.js';

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    BUDGET_ALERT_PROCESS_CODES: 'PROC-CA8104B8-341A-4B2C-92AA-8091C08BA11B',
    BUDGET_ALERT_FIELD_MAP: JSON.stringify({
      'PROC-CA8104B8-341A-4B2C-92AA-8091C08BA11B': {
        applicationDateFieldId: 'DDDateField_B0K470VSL0O0',
        budgetTypeFieldId: 'DDSelectField_14ZWYSLFU1400',
        serviceEntityFieldId: 'CascadeField_G8SEQLCWG1S0',
        amountFieldId: 'MoneyField_1FPZGEQOZ4M80',
        splits: [],
      },
    }),
    BUDGET_ALERT_API_KEY: 'test-key',
    DINGTALK_ALERT_RECIPIENT_USER_IDS: 'receiver-1',
  }),
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
});
