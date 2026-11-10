import { getConfig } from '../config/index.js';

interface AccessTokenResponse {
  accessToken?: string;
  expireIn?: number;
}

interface ChatSendResponse {
  processQueryKey?: string;
  invalidStaffIdList?: string[];
  flowControlledStaffIdList?: string[];
}

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;

function requiredRobotConfig() {
  const config = getConfig();
  if (!config.DINGTALK_ALERT_ROBOT_CODE || !config.DINGTALK_ALERT_CLIENT_ID || !config.DINGTALK_ALERT_CLIENT_SECRET) {
    throw new Error('统一预警机器人未配置 DINGTALK_ALERT_ROBOT_CODE / CLIENT_ID / CLIENT_SECRET');
  }
  return config;
}

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < accessTokenExpiresAt - 5 * 60_000) {
    return accessToken;
  }

  const config = requiredRobotConfig();
  const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: config.DINGTALK_ALERT_CLIENT_ID, appSecret: config.DINGTALK_ALERT_CLIENT_SECRET }),
  });
  if (!response.ok) {
    throw new Error(`统一预警机器人获取 token 失败: HTTP ${response.status}`);
  }

  const body = await response.json() as AccessTokenResponse;
  if (!body.accessToken) {
    throw new Error('统一预警机器人获取 token 失败: 响应缺少 accessToken');
  }
  accessToken = body.accessToken;
  accessTokenExpiresAt = Date.now() + Math.max(60, Number(body.expireIn || 7200)) * 1000;
  return accessToken;
}

export async function sendAlertChatMessage(userIds: string[], content: string): Promise<void> {
  if (!userIds.length) return;
  const config = requiredRobotConfig();
  const token = await getAccessToken();
  const response = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': token,
    },
    body: JSON.stringify({
      robotCode: config.DINGTALK_ALERT_ROBOT_CODE,
      userIds,
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title: '统一预警', text: content }),
    }),
  });
  if (!response.ok) {
    throw new Error(`统一预警机器人发送聊天消息失败: HTTP ${response.status}`);
  }
  const body = await response.json() as ChatSendResponse;
  if (body.invalidStaffIdList?.length || body.flowControlledStaffIdList?.length) {
    throw new Error(`统一预警机器人聊天消息未完全送达: 无效用户 ${body.invalidStaffIdList?.length || 0}，限流用户 ${body.flowControlledStaffIdList?.length || 0}`);
  }
  if (!body.processQueryKey) throw new Error('ALERT_ROBOT_PERSONAL_SEND_RESPONSE_INVALID');
}

export async function sendAlertGroupMessage(
  conversationId: string,
  content: string,
  mentionUserIds: string[] = [],
): Promise<void> {
  if (!conversationId.trim()) throw new Error('ALERT_ROBOT_GROUP_ID_REQUIRED');
  const atUserIds = [...new Set(mentionUserIds.map((id) => id.trim()).filter(Boolean))];
  // 应用机器人须同时传 atUserIds 和正文 @userId 标记；不能只拼接姓名。
  const text = atUserIds.length ? `${atUserIds.map((id) => `@${id}`).join(' ')}\n\n${content}` : content;
  const config = requiredRobotConfig();
  const token = await getAccessToken();
  const response = await fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': token,
    },
    body: JSON.stringify({
      robotCode: config.DINGTALK_ALERT_ROBOT_CODE,
      openConversationId: conversationId,
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title: '统一预警', text }),
      ...(atUserIds.length ? { atUserIds, isAtAll: false } : {}),
    }),
  });
  if (!response.ok) throw new Error(`ALERT_ROBOT_GROUP_SEND_FAILED: HTTP ${response.status}`);
  const body = await response.json() as ChatSendResponse;
  if (!body.processQueryKey) throw new Error('ALERT_ROBOT_GROUP_SEND_RESPONSE_INVALID');
}
