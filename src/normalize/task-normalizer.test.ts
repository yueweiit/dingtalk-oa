import { describe, expect, it } from 'vitest';
import { normalizeTasks } from './task-normalizer.js';
import { approvalTaskSchema } from '../dingtalk/types.js';

describe('normalizeTasks', () => {
  it('uses DingTalk taskGroupName when nodeName is absent', () => {
    const [task] = normalizeTasks('corp-1', 'instance-1', [{
      taskId: 'task-1',
      taskGroupName: '财务审批',
      status: 'RUNNING',
      userId: 'user-1',
      createTime: '2026-09-20T01:00:00Z',
    }]);

    expect(task.node_name).toBe('财务审批');
  });

  it('keeps nodeName as the preferred field', () => {
    const [task] = normalizeTasks('corp-1', 'instance-1', [{
      taskId: 'task-1',
      nodeName: '正式节点名称',
      taskGroupName: '兼容节点名称',
      status: 'COMPLETED',
    }]);

    expect(task.node_name).toBe('正式节点名称');
  });

  it('falls back from blank nodeName and normalizes identifiers without changing the original payload', () => {
    const raw = approvalTaskSchema.parse({ status: 'RUNNING', taskId: 123, userId: ' user-1 ', deptId: 20,
      nodeName: ' ', taskGroupName: '财务', userName: '', deptName: ' ' });
    const [task] = normalizeTasks('corp-1', 'instance-1', [raw]);
    expect(task).toMatchObject({ task_id: '123', node_name: '财务', approver_user_id: 'user-1',
      approver_user_name: null, approver_dept_id: '20', approver_dept_name: null });
    expect(task.raw_payload).toEqual(raw);
  });
});
