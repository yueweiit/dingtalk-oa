import type { DingApprovalInstance } from '../db/types.js';
import { firstText } from './text.js';

const templates = {
  'PROC-A917A16C-ADED-42A0-830A-DF20A5880948': {
    region: 'CN', employeeName: 'TextField_SGOO4D848XC0', date: 'DDDateField_TQHUCEXTH2O0', dingtalkName: null,
  },
  'PROC-7DB16FD2-70D6-41AE-9C5D-AE3DFF53A957': {
    region: 'MX', employeeName: 'TextField_6RXTO615OMS0', date: 'DDDateField_EZMO31OXMUW0', dingtalkName: 'TextareaField_1POXA3C2RB9C0',
  },
} as const;

export const departureProcessCodes = Object.keys(templates);

export type DepartureSource = Pick<DingApprovalInstance,
  'corp_id' | 'process_instance_id' | 'process_code' | 'status' | 'result' | 'deleted_at' |
  'originator_user_id' | 'raw_payload'>;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function formValue(components: unknown, id: string | null): string | null {
  if (!id || !Array.isArray(components)) return null;
  const matches = components.map(object).filter(field => field?.id === id);
  return matches.length === 1 && typeof matches[0]?.value === 'string' ? firstText(matches[0].value) : null;
}

function calendarDate(value: string | null): string | null {
  if (!value || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function approved(status: unknown, result: unknown): boolean {
  return firstText(status)?.toUpperCase() === 'COMPLETED' && firstText(result)?.toLowerCase() === 'agree';
}

export function departureFromApproval(source: DepartureSource) {
  if (source.deleted_at || !approved(source.status, source.result)) return null;
  if (!Object.hasOwn(templates, source.process_code)) return null;
  const template = templates[source.process_code as keyof typeof templates];

  // The archive can merge status, result and form values from separate responses.
  // Only the original detail can prove that this date belongs to the approved version.
  const raw = object(source.raw_payload);
  const approvedDetail = approved(raw?.status, raw?.result);
  const components = raw?.formComponentValues;
  const originator = object(raw?.originator);
  const submitterIds = [...new Set([originator?.userId, raw?.originatorUserId, raw?.originatorId]
    .map(value => firstText(value)).filter((id): id is string => id !== null && /^\S{1,128}$/.test(id)))];
  const submitterId = submitterIds.length === 1 ? submitterIds[0] : null;
  // The archived name may have been filled from another departure. Use names from this approval only.
  const originatorName = template.region === 'CN' && submitterId ? firstText(
    firstText(originator?.userId) === submitterId ? originator?.name : null,
    firstText(raw?.originatorUserId, raw?.originatorId) === submitterId ? raw?.originatorUserName : null,
  ) : null;

  return {
    region: template.region,
    employeeName: formValue(components, template.employeeName) ?? originatorName,
    dingtalkName: formValue(components, template.dingtalkName),
    departedOn: approvedDetail ? calendarDate(formValue(components, template.date)) : null,
    approvedDetail,
    submitterId,
    submitterIds,
  };
}
