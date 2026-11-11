import { alertMarkdownParams } from '../dingtalk/alert-markdown.js';

// 按钉钉群消息 msgParam 的 15000 字节上限切分，个人也沿用相同长度预算。
const MAX_MARKDOWN_PARAM_BYTES = 15_000;

// 新增通知语言时在此扩展，保留业务名称的原始语言。
const templates = {
  'zh-CN': {
    title: '审批超时汇总',
    count: (value: string) => `${value} 个待审批节点`,
    labelSeparator: '：',
    node: '节点',
    approver: '待审批人',
    unknownNode: '未命名审批节点',
    unknownApprover: '未识别审批人',
    waited: '已等待',
    link: '查看审批',
    duration: (hours: string, minutes: string) => `${hours}小时${minutes}分钟`,
  },
  es: {
    title: 'Aprobaciones vencidas',
    count: (value: string, count: number) => `${value} ${count === 1 ? 'tarea pendiente' : 'tareas pendientes'}`,
    labelSeparator: ': ',
    node: 'Etapa',
    approver: 'Responsable',
    unknownNode: 'Etapa sin nombre',
    unknownApprover: 'Responsable sin identificar',
    waited: 'Tiempo de espera',
    link: 'Ver aprobación',
    duration: (hours: string, minutes: string) => `${hours} h ${minutes} min`,
  },
};

const locales = ['zh-CN', 'es'] as const;
export type ApprovalTimeoutLocale = typeof locales[number];
const numbers = {
  'zh-CN': new Intl.NumberFormat('zh-CN', { useGrouping: false }),
  es: new Intl.NumberFormat('es', { useGrouping: false }),
};

export interface ApprovalTimeoutMessageItem {
  title: string;
  nodeName: string | null;
  approver: string | null;
  approverUserId: string | null;
  waitedMs: number;
  approvalUrl: string;
  locale: ApprovalTimeoutLocale;
}

interface ApprovalTimeoutMessage<T> {
  items: T[];
  title: string;
  content: string;
  mentionUserIds: string[];
}

function label(value: string): string {
  const characters = Array.from(value.replace(/\s+/gu, ' ').trim());
  const short = characters.length > 120 ? `${characters.slice(0, 120).join('')}…` : characters.join('');
  return short.replace(/[\\`*_\[\]<>]/g, '\\$&');
}

export function buildApprovalTimeoutMessages<T extends ApprovalTimeoutMessageItem>(
  items: T[],
  mentionApprovers: boolean,
): ApprovalTimeoutMessage<T>[] {
  const line = (item: T) => {
    const text = templates[item.locale];
    const number = numbers[item.locale];
    const minutes = Math.max(0, Math.floor(item.waitedMs / 60_000));
    const waited = text.duration(number.format(Math.floor(minutes / 60)), number.format(minutes % 60));
    return `- ${label(item.title)} · ${text.node}${text.labelSeparator}${label(item.nodeName || text.unknownNode)}`
      + ` · ${text.approver}${text.labelSeparator}${label(item.approver || item.approverUserId || text.unknownApprover)}`
      + ` · ${text.waited}${text.labelSeparator}${waited} · [${text.link}](${item.approvalUrl})`;
  };
  const render = (entries: T[]): ApprovalTimeoutMessage<T> => {
    const usedLocales = locales.filter(locale => entries.some(item => item.locale === locale));
    const title = usedLocales.map(locale => templates[locale].title).join(' / ');
    const summary = usedLocales.map(locale => templates[locale].count(numbers[locale].format(entries.length), entries.length)).join(' / ');
    return {
      items: entries,
      title,
      content: `**${title}** · ${summary}\n\n${entries.map(line).join('\n')}`,
      mentionUserIds: mentionApprovers
        ? [...new Set(entries.flatMap(item => item.approverUserId ? [item.approverUserId] : []))]
        : [],
    };
  };
  const fits = (message: ApprovalTimeoutMessage<T>) => Buffer.byteLength(
    alertMarkdownParams(message.content, message.mentionUserIds, message.title),
  ) <= MAX_MARKDOWN_PARAM_BYTES;
  const messages: ApprovalTimeoutMessage<T>[] = [];
  let pending: ApprovalTimeoutMessage<T> | undefined;
  for (const item of items) {
    const extended = render([...(pending?.items ?? []), item]);
    if (fits(extended)) {
      pending = extended;
      continue;
    }
    if (pending) messages.push(pending);
    pending = render([item]);
    if (!fits(pending)) throw new Error('APPROVAL_TIMEOUT_MESSAGE_TOO_LARGE');
  }
  if (pending) messages.push(pending);
  return messages;
}
