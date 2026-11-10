// 仅正式支持简体中文；新增通知语言时在此扩展，不改业务状态或源名称。
const templates = {
  'zh-CN': {
    title: '【审批已超时】',
    process: '流程',
    node: '节点',
    approver: '待审批人',
    unknownNode: '未命名审批节点',
    unknownApprover: '未识别审批人',
    waited: '已等待',
    limit: '首次提醒时限',
    link: '审批单',
    repeat: '此后每满 24 小时提醒一次，当前任务处理结束后停止提醒。',
    duration: (hours: string, minutes: string) => `${hours}小时${minutes}分钟`,
  },
};

export function buildApprovalTimeoutMessage(params: {
  title: string;
  nodeName: string | null;
  approver: string | null;
  waitedMs: number;
  timeoutMs: number;
  approvalUrl: string;
  locale?: keyof typeof templates;
}): string {
  const locale = params.locale ?? 'zh-CN';
  const text = templates[locale];
  const number = new Intl.NumberFormat(locale, { useGrouping: false });
  const duration = (ms: number) => {
    const minutes = Math.max(0, Math.floor(ms / 60_000));
    return text.duration(number.format(Math.floor(minutes / 60)), number.format(minutes % 60));
  };
  return [
    text.title,
    `${text.process}：${params.title}`,
    `${text.node}：${params.nodeName || text.unknownNode}`,
    `${text.approver}：${params.approver || text.unknownApprover}`,
    `${text.waited}：${duration(params.waitedMs)}（${text.limit} ${duration(params.timeoutMs)}）`,
    text.repeat,
    `${text.link}：${params.approvalUrl}`,
  ].join('\n\n');
}
