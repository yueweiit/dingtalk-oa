export const TOPICS = {
  // 审批事件原始 topic
  APPROVAL_EVENTS_RAW: 'approval.events.raw',

  // 失败事件 DLQ topic
  APPROVAL_EVENTS_DLQ: 'approval.events.dlq',
};

export function getTopicConfig() {
  return {
    numPartitions: 3,
    replicationFactor: 1,
  };
}
