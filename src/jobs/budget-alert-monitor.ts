import { getConfig } from '../config/index.js';
import {
  claimAlertDelivery,
  markAlertDeliveryFailed,
  markAlertDeliverySent,
  type AlertDeliveryKey,
} from '../db/queries/alert-notification.js';
import { sendAlertChatMessage } from '../dingtalk/alert-robot.js';
import type { ApprovalInstanceDetail, FormComponentValue } from '../dingtalk/types.js';

const ALERT_TYPE = 'budget_threshold';

export interface BudgetAlertFieldMap {
  applicationDateFieldId: string;
  budgetTypeFieldId: string;
  serviceEntityFieldId: string;
  amountFieldId: string;
  splits?: BudgetAlertSplitFieldMap[];
}

export interface BudgetAlertSplitFieldMap {
  tableFieldId: string;
  departmentFieldId: string;
  amountFieldId: string;
}

export interface BudgetAlertInput {
  departmentId: string;
  serviceEntityName: string;
  month: string;
  budgetType: string;
  applicationAmount: number;
  source: 'service_entity' | 'department_split';
}

export interface BudgetAlertSnapshot {
  departmentId: string;
  month: string;
  budgetAmount: number;
  usedAmount: number;
  applicationAmount: number;
  projectedAmount: number;
  utilizationRate: number | null;
  alertLevel: 'normal' | 'warning_90' | 'over_budget' | 'missing_budget';
}

export interface BudgetAlertMonitorDependencies {
  fetchSnapshot: (input: BudgetAlertInput) => Promise<BudgetAlertSnapshot>;
  claimDelivery: (key: AlertDeliveryKey, payload: Record<string, unknown>) => Promise<boolean>;
  markSent: (key: AlertDeliveryKey) => Promise<void>;
  markFailed: (key: AlertDeliveryKey, error: string) => Promise<void>;
  send: (userIds: string[], content: string) => Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseProcessCodes(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
}

function parseRecipients(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
}

export function parseBudgetAlertFieldMap(value: string): Record<string, BudgetAlertFieldMap> {
  if (!value.trim()) return {};
  try {
    const parsed = asRecord(JSON.parse(value));
    return Object.fromEntries(Object.entries(parsed).flatMap(([processCode, candidate]) => {
      const map = asRecord(candidate);
      const required = ['applicationDateFieldId', 'budgetTypeFieldId', 'serviceEntityFieldId', 'amountFieldId'];
      if (required.some((key) => typeof map[key] !== 'string' || !String(map[key]).trim())) {
        return [];
      }
      const splits = (Array.isArray(map.splits) ? map.splits : []).flatMap((candidate) => {
        const split = asRecord(candidate);
        const splitRequired = ['tableFieldId', 'departmentFieldId', 'amountFieldId'];
        if (splitRequired.some((key) => typeof split[key] !== 'string' || !String(split[key]).trim())) {
          return [];
        }
        return [{
          tableFieldId: String(split.tableFieldId),
          departmentFieldId: String(split.departmentFieldId),
          amountFieldId: String(split.amountFieldId),
        }];
      });
      return [[processCode, {
        applicationDateFieldId: String(map.applicationDateFieldId),
        budgetTypeFieldId: String(map.budgetTypeFieldId),
        serviceEntityFieldId: String(map.serviceEntityFieldId),
        amountFieldId: String(map.amountFieldId),
        splits,
      }]];
    }));
  } catch {
    console.warn('[BudgetAlert] BUDGET_ALERT_FIELD_MAP 不是有效 JSON，跳过预算预警');
    return {};
  }
}

function findField(fields: FormComponentValue[], id: string): FormComponentValue | undefined {
  return fields.find((field) => field.id === id);
}

function hasMeaningfulValue(value: unknown): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (parsed && typeof parsed === 'object') return Object.keys(parsed).length > 0;
  } catch {
    // A scalar text value is meaningful.
  }
  return true;
}

function tableRows(field: FormComponentValue): unknown[] {
  const record = asRecord(field);
  const details = record.details;
  if (Array.isArray(details)) return details;
  const parsed = parseJsonValue(field.value);
  if (Array.isArray(parsed)) return parsed;
  const parsedRecord = asRecord(parsed);
  const rows = parsedRecord.rows ?? parsedRecord.details ?? parsedRecord.value;
  return Array.isArray(rows) ? rows : [];
}

function rowCells(row: unknown): unknown[] {
  if (Array.isArray(row)) return row;
  const record = asRecord(row);
  const cells = record.rowValue ?? record.values ?? record.value;
  return Array.isArray(cells) ? cells : [];
}

function tableHasRows(field: FormComponentValue): boolean {
  return tableRows(field).length > 0 || hasMeaningfulValue(field.value);
}

function isTableField(field: FormComponentValue): boolean {
  const record = asRecord(field);
  const componentType = String(record.componentType ?? '').toLowerCase();
  const componentName = String(parseJsonRecord(record.extValue).componentName ?? '').toLowerCase();
  return componentType.includes('tablefield') || componentName.includes('tablefield') || String(field.id ?? '').startsWith('TableField_');
}

function amountOf(value: unknown): number | null {
  const amount = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function departmentIdentity(cell: Record<string, unknown>): { id: string; name: string } | null {
  const sources = [cell.extendValue, cell.extValue, cell.value].map(parseJsonValue);
  for (const source of sources) {
    const candidates = Array.isArray(source) ? source : [source];
    for (const candidate of candidates) {
      const record = asRecord(candidate);
      const id = String(record.id ?? record.itemId ?? record.deptId ?? record.dept_id ?? record.code ?? '').trim();
      if (!id) continue;
      const name = String(record.name ?? record.label ?? cell.value ?? id).trim();
      return { id, name: name || id };
    }
  }
  return null;
}

function commonBudgetFields(
  fields: FormComponentValue[],
  fieldMap: BudgetAlertFieldMap,
): { month: string; budgetType: string } | null {
  const date = findField(fields, fieldMap.applicationDateFieldId);
  const budgetType = findField(fields, fieldMap.budgetTypeFieldId);
  const monthMatch = String(date?.value ?? '').match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (!monthMatch || !budgetType) return null;
  const typeKey = String(parseJsonRecord(budgetType.extValue).key ?? '').trim();
  return {
    month: `${monthMatch[1]}-${String(Number(monthMatch[2])).padStart(2, '0')}`,
    budgetType: typeKey || String(budgetType.value ?? ''),
  };
}

function extractSplitBudgetInputs(
  fields: FormComponentValue[],
  fieldMap: BudgetAlertFieldMap,
  common: { month: string; budgetType: string },
): { inputs?: BudgetAlertInput[]; reason?: string } {
  const splitMaps = fieldMap.splits ?? [];
  const configuredTableIds = new Set(splitMaps.map((split) => split.tableFieldId));
  const populatedTables = fields.filter((field) => isTableField(field) && tableHasRows(field));
  if (populatedTables.some((field) => !configuredTableIds.has(String(field.id ?? '')))) {
    return { reason: 'unconfigured_split_table' };
  }

  const totals = new Map<string, { name: string; amount: number }>();
  for (const split of splitMaps) {
    const table = findField(fields, split.tableFieldId);
    if (!table) continue;
    for (const row of tableRows(table)) {
      const cells = rowCells(row).map(asRecord);
      const amountCell = cells.find((cell) => String(cell.id ?? cell.key ?? '') === split.amountFieldId);
      const amount = amountOf(amountCell?.value);
      if (amount === null || amount <= 0) continue;
      const departmentCell = cells.find((cell) => String(cell.id ?? cell.key ?? '') === split.departmentFieldId);
      const department = departmentIdentity(departmentCell ?? {});
      if (!department) return { reason: 'split_department_id_missing' };
      const current = totals.get(department.id);
      totals.set(department.id, {
        name: department.name,
        amount: Number(((current?.amount ?? 0) + amount).toFixed(2)),
      });
    }
  }

  if (!totals.size) return { reason: 'split_rows_missing' };
  return {
    inputs: [...totals.entries()].map(([departmentId, value]) => ({
      departmentId,
      serviceEntityName: value.name,
      month: common.month,
      budgetType: common.budgetType,
      applicationAmount: value.amount,
      source: 'department_split',
    })),
  };
}

/**
 * Extracts the fixed fields for a configured process. A non-empty table component
 * is deliberately not guessed: its split schema must be configured from a real form sample.
 */
export function extractBudgetAlertInput(
  detail: ApprovalInstanceDetail,
  fieldMap: BudgetAlertFieldMap,
): { input?: BudgetAlertInput; reason?: string } {
  const fields = detail.formComponentValues ?? [];
  if (fields.some((field) => isTableField(field) && tableHasRows(field))) {
    return { reason: 'unconfigured_split_table' };
  }

  const common = commonBudgetFields(fields, fieldMap);
  const entity = findField(fields, fieldMap.serviceEntityFieldId);
  const amount = findField(fields, fieldMap.amountFieldId);
  const entityInfo = parseJsonRecord(entity?.extValue);
  const departmentId = String(entityInfo.code ?? '').trim();
  const applicationAmount = amountOf(amount?.value);

  if (!common || !departmentId || applicationAmount === null) {
    return { reason: 'required_field_missing' };
  }

  return {
    input: {
      departmentId,
      serviceEntityName: String(entityInfo.name ?? entity?.value ?? departmentId),
      month: common.month,
      budgetType: common.budgetType,
      applicationAmount,
      source: 'service_entity',
    },
  };
}

export function extractBudgetAlertInputs(
  detail: ApprovalInstanceDetail,
  fieldMap: BudgetAlertFieldMap,
): { inputs?: BudgetAlertInput[]; reason?: string } {
  const fields = detail.formComponentValues ?? [];
  const common = commonBudgetFields(fields, fieldMap);
  if (!common) return { reason: 'required_field_missing' };
  if ((fieldMap.splits ?? []).length > 0) {
    return extractSplitBudgetInputs(fields, fieldMap, common);
  }
  const extracted = extractBudgetAlertInput(detail, fieldMap);
  return extracted.input ? { inputs: [extracted.input] } : { reason: extracted.reason };
}

async function fetchBudgetAlertSnapshot(input: BudgetAlertInput): Promise<BudgetAlertSnapshot> {
  const config = getConfig();
  if (!config.BUDGET_ALERT_API_KEY) {
    throw new Error('未配置 BUDGET_ALERT_API_KEY');
  }
  const query = new URLSearchParams({
    departmentId: input.departmentId,
    month: input.month,
    type: input.budgetType,
    applicationAmount: String(input.applicationAmount),
  });
  const response = await fetch(`${config.BUDGET_ALERT_API_URL}?${query}`, {
    headers: { 'x-budget-alert-key': config.BUDGET_ALERT_API_KEY },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as { success?: boolean; message?: string; data?: BudgetAlertSnapshot };
  if (!response.ok || !body.success || !body.data) {
    throw new Error(`预算快照查询失败: ${body.message || `HTTP ${response.status}`}`);
  }
  return body.data;
}

const defaultDependencies: BudgetAlertMonitorDependencies = {
  fetchSnapshot: fetchBudgetAlertSnapshot,
  claimDelivery: claimAlertDelivery,
  markSent: markAlertDeliverySent,
  markFailed: markAlertDeliveryFailed,
  send: sendAlertChatMessage,
};

function formatAmount(value: number): string {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function monitorBudgetAlertForInstance(
  corpId: string,
  detail: ApprovalInstanceDetail,
  dependencies: BudgetAlertMonitorDependencies = defaultDependencies,
): Promise<{ status: string; sent: number; reason?: string }> {
  if (!String(detail.processInstanceId ?? '').trim()) {
    return { status: 'skipped', sent: 0, reason: 'instance_id_missing' };
  }
  if (String(detail.status).toUpperCase() !== 'RUNNING') return { status: 'skipped', sent: 0, reason: 'not_running' };

  const config = getConfig();
  const processCode = String(detail.processCode ?? '').trim();
  if (!parseProcessCodes(config.BUDGET_ALERT_PROCESS_CODES).includes(processCode)) {
    return { status: 'skipped', sent: 0, reason: 'process_not_configured' };
  }
  const recipients = parseRecipients(config.DINGTALK_ALERT_RECIPIENT_USER_IDS);
  if (!recipients.length || !config.BUDGET_ALERT_API_KEY) {
    return { status: 'skipped', sent: 0, reason: 'notification_not_configured' };
  }
  const fieldMap = parseBudgetAlertFieldMap(config.BUDGET_ALERT_FIELD_MAP)[processCode];
  if (!fieldMap) return { status: 'skipped', sent: 0, reason: 'field_map_missing' };

  const extracted = extractBudgetAlertInputs(detail, fieldMap);
  if (!extracted.inputs) {
    console.warn(`[BudgetAlert] 跳过 ${detail.processInstanceId}: ${extracted.reason}`);
    return { status: 'skipped', sent: 0, reason: extracted.reason };
  }

  const approvalUrl = `https://applink.dingtalk.com/approval/detail?corpId=${encodeURIComponent(corpId)}&instanceId=${encodeURIComponent(String(detail.processInstanceId ?? ''))}`;
  let sent = 0;
  const statuses: BudgetAlertSnapshot['alertLevel'][] = [];
  for (const input of extracted.inputs) {
    const snapshot = await dependencies.fetchSnapshot(input);
    statuses.push(snapshot.alertLevel);
    // A missing or zero budget is intentionally silent, including split departments.
    if (snapshot.alertLevel === 'missing_budget' || snapshot.budgetAmount <= 0) continue;
    if (snapshot.alertLevel !== 'warning_90' && snapshot.alertLevel !== 'over_budget') continue;

    const isOverBudget = snapshot.alertLevel === 'over_budget';
    const levelLabel = isOverBudget ? '预算不足' : '预算预警';
    const dimensionLabel = input.source === 'department_split' ? '部门' : '服务主体';
    const content = [
      `【${levelLabel}】`,
      `流程：${detail.title || processCode}`,
      `${dimensionLabel}：${input.serviceEntityName}`,
      `月份：${snapshot.month}`,
      `月预算：${formatAmount(snapshot.budgetAmount)}；已用：${formatAmount(snapshot.usedAmount)}；本次：${formatAmount(snapshot.applicationAmount)}；预计：${formatAmount(snapshot.projectedAmount)}`,
      `预算使用率：${snapshot.utilizationRate === null ? '无有效预算' : `${(snapshot.utilizationRate * 100).toFixed(2)}%`}`,
      `审批单：${approvalUrl}`,
    ].join('\n');

    for (const recipientUserId of recipients) {
      const key: AlertDeliveryKey = {
        corpId,
        processInstanceId: String(detail.processInstanceId ?? ''),
        alertType: ALERT_TYPE,
        alertPhase: `${snapshot.alertLevel}:${snapshot.departmentId}:${snapshot.month}`,
        recipientUserId,
      };
      const claimed = await dependencies.claimDelivery(key, {
        processCode,
        source: input.source,
        departmentId: snapshot.departmentId,
        departmentName: input.serviceEntityName,
        month: snapshot.month,
        alertLevel: snapshot.alertLevel,
        budgetAmount: snapshot.budgetAmount,
        usedAmount: snapshot.usedAmount,
        applicationAmount: snapshot.applicationAmount,
        projectedAmount: snapshot.projectedAmount,
      });
      console.log(`[BudgetAlert] ${detail.processInstanceId}: department=${snapshot.departmentId}, recipient=${recipientUserId}, claimed=${claimed}`);
      if (!claimed) continue;
      try {
        await dependencies.send([recipientUserId], content);
        await dependencies.markSent(key);
        sent++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await dependencies.markFailed(key, message);
        console.error(`[BudgetAlert] 发送失败: ${detail.processInstanceId}`, message);
      }
    }
  }
  const status = statuses.includes('over_budget')
    ? 'over_budget'
    : statuses.includes('warning_90')
      ? 'warning_90'
      : statuses.includes('normal')
        ? 'normal'
        : 'missing_budget';
  return { status, sent };
}
