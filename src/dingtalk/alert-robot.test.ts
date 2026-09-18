import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendAlertChatMessage } from './alert-robot.js';

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    DINGTALK_ALERT_ROBOT_CODE: 'robot-1',
    DINGTALK_ALERT_CLIENT_ID: 'client-1',
    DINGTALK_ALERT_CLIENT_SECRET: 'secret-1',
  }),
}));

afterEach(() => vi.unstubAllGlobals());

describe('sendAlertChatMessage', () => {
  it('sends a markdown message to the robot chat instead of creating a DING', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: 'token-1', expireIn: 7200 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ processQueryKey: 'message-1' }) });
    vi.stubGlobal('fetch', fetchMock);

    await sendAlertChatMessage(['user-1'], '【预算预警】\n测试内容');

    expect(fetchMock).toHaveBeenNthCalledWith(2,
      'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
      expect.objectContaining({
        body: JSON.stringify({
          robotCode: 'robot-1',
          userIds: ['user-1'],
          msgKey: 'sampleMarkdown',
          msgParam: JSON.stringify({ title: '统一预警', text: '【预算预警】\n测试内容' }),
        }),
      }),
    );
  });
});
