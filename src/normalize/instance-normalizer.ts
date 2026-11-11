import type { ApprovalInstanceDetail } from '../dingtalk/types.js';
import type { JsonValue } from '../db/json-types.js';
import { firstText } from './text.js';

export interface NormalizedInstance {
  corp_id: string;
  process_instance_id: string;
  process_code: string;
  title: string | null;
  status: string | null;
  result: string | null;
  originator_user_id: string | null;
  originator_user_name: string | null;
  originator_dept_id: string | null;
  originator_dept_name: string | null;
  create_time: Date | null;
  finish_time: Date | null;
  form_component_values: JsonValue | null;
  raw_payload: JsonValue | null;
  last_event_time: Date | null;
}

/**
 * 确保对象可以安全序列化为 JSON（去掉不可序列化的值）
 */
function safeSerialize(obj: unknown): JsonValue | null {
  if (obj == null) return null;
  try {
    return JSON.parse(JSON.stringify(obj, (_key, value) =>
      typeof value === 'bigint' ? String(value) : value
    ));
  } catch {
    return null;
  }
}

export function normalizeInstance(
  corp_id: string,
  detail: ApprovalInstanceDetail,
  fallbacks?: { processInstanceId?: string; processCode?: string; originatorUserId?: string }
): NormalizedInstance {
  const rootUserId = firstText(detail.originatorUserId, detail.originatorId);
  const userId = firstText(detail.originator?.userId, rootUserId, fallbacks?.originatorUserId);
  const sameRootUser = !rootUserId || rootUserId === userId;
  const rootDeptId = sameRootUser ? firstText(detail.originatorDeptId) : null;
  const deptId = firstText(detail.originator?.deptId, rootDeptId);
  return {
    corp_id,
    process_instance_id: detail.processInstanceId || fallbacks?.processInstanceId || '',
    process_code: detail.processCode || fallbacks?.processCode || '',
    title: detail.title ?? null,
    status: detail.status ?? null,
    result: detail.result ?? null,
    originator_user_id: userId,
    originator_user_name: firstText(detail.originator?.name, sameRootUser ? detail.originatorUserName : null),
    originator_dept_id: deptId,
    originator_dept_name: firstText(detail.originator?.deptName,
      sameRootUser && (!rootDeptId || rootDeptId === deptId) ? detail.originatorDeptName : null),
    create_time: parseDingTalkTime(detail.createTime),
    finish_time: parseDingTalkTime(detail.finishTime),
    form_component_values: safeSerialize(detail.formComponentValues),
    raw_payload: safeSerialize(detail),
    last_event_time: new Date(),
  };
}

/**
 * 解析钉钉时间字符串（UTC+8）
 * 钉钉返回格式通常是：2026-07-03T10:00:00Z 或 2026-07-03 10:00:00
 */
export function parseDingTalkTime(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);

  const timeStr = String(value ?? '').trim();
  if (!timeStr) return null;

  try {
    // 如果是时间戳（毫秒），直接转换
    const timestamp = Number(timeStr);
    if (!isNaN(timestamp) && timestamp > 0) {
      return new Date(timestamp);
    }

    // 钉钉带 Z 的时间实际是北京时间墙上时间，不能按 UTC 直接解析。
    const normalized = /Z$/i.test(timeStr) ? `${timeStr.slice(0, -1)}+08:00` : timeStr;
    const date = new Date(normalized);
    if (isNaN(date.getTime())) {
      console.warn('[InstanceNormalizer] 无法解析时间:', timeStr);
      return null;
    }

    return date;
  } catch (error) {
    console.warn('[InstanceNormalizer] 时间解析错误:', timeStr, error);
    return null;
  }
}
