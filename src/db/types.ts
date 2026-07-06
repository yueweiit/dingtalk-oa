import type { JsonValue } from './json-types.js';

// 审批模板
export interface DingProcessTemplate {
  id: bigint;
  corp_id: string;
  process_code: string;
  name: string | null;
  enabled: boolean;
  is_deleted: boolean;
  remark: string | null;
  last_sync_at: Date | null;
  updated_at: Date;
  created_at: Date;
}

// 审批实例
export interface DingApprovalInstance {
  id: bigint;
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
  deleted_at: Date | null;
  updated_at: Date;
  created_at: Date;
}

// 审批任务
export interface DingApprovalTask {
  id: bigint;
  corp_id: string;
  process_instance_id: string;
  task_id: string;
  task_order: number | null;
  activity_id: string | null;
  node_name: string | null;
  status: string | null;
  result: string | null;
  approver_user_id: string | null;
  approver_user_name: string | null;
  approver_dept_id: string | null;
  approver_dept_name: string | null;
  start_time: Date | null;
  end_time: Date | null;
  remark: string | null;
  raw_payload: JsonValue | null;
  updated_at: Date;
  created_at: Date;
}

// 用户快照
export interface DingUserSnapshot {
  id: bigint;
  corp_id: string;
  user_id: string;
  name: string | null;
  dept_id_list: JsonValue | null;
  title: string | null;
  avatar: string | null;
  snapshot_hash: string;
  valid_from: Date;
  valid_to: Date | null;
  is_current: boolean;
  fetch_status: string;
  fetch_error: string | null;
  raw_payload: JsonValue | null;
  updated_at: Date;
}

// 表单字段
export interface DingFormField {
  id: bigint;
  corp_id: string;
  process_code: string;
  field_id: string;
  field_name: string | null;
  field_type: string | null;
  is_deleted: boolean;
  raw_payload: JsonValue | null;
  updated_at: Date;
  created_at: Date;
}

// 补数据游标
export interface BackfillCursor {
  id: bigint;
  corp_id: string;
  process_code: string;
  window_start: Date;
  window_end: Date;
  status: string;
  cursor_offset: number;
  processed_count: number;
  started_at: Date;
  finished_at: Date | null;
  error_message: string | null;
  created_at: Date;
}

// 事件日志
export interface DingEventLog {
  id: bigint;
  corp_id: string;
  event_id: string | null;
  event_type: string;
  source: string;
  process_instance_id: string | null;
  process_code: string | null;
  received_at: Date;
  processed_at: Date | null;
  duration_ms: number | null;
  status: string;
  retry_count: number;
  error_message: string | null;
  raw_event: JsonValue | null;
}
