import type { ApprovalTask } from '../dingtalk/types.js';
import type { JsonValue } from '../db/json-types.js';
import { parseDingTalkTime } from './instance-normalizer.js';

export interface NormalizedTask {
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
}

export function normalizeTasks(
  corp_id: string,
  process_instance_id: string,
  tasks: ApprovalTask[]
): NormalizedTask[] {
  return tasks.map((task, index) => ({
    corp_id,
    process_instance_id,
    task_id: task.taskId ?? `task_${process_instance_id}_${index}`,
    task_order: index + 1,
    activity_id: task.activityId ?? null,
    node_name: task.nodeName ?? null,
    status: task.status ?? null,
    result: task.result ?? null,
    approver_user_id: task.userId ?? null,
    approver_user_name: task.userName ?? null,
    approver_dept_id: task.deptId ?? null,
    approver_dept_name: task.deptName ?? null,
    start_time: parseDingTalkTime(task.startTime),
    end_time: parseDingTalkTime(task.endTime),
    remark: task.remark ?? null,
    raw_payload: task as unknown as JsonValue,
  }));
}
