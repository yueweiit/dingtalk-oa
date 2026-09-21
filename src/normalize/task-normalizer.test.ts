import { describe, expect, it } from 'vitest';
import { normalizeTasks } from './task-normalizer.js';

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
});
