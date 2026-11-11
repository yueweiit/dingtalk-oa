import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    DINGTALK_ALERT_ROBOT_CODE: 'robot-1',
    DINGTALK_ALERT_CLIENT_ID: 'client-1',
    DINGTALK_ALERT_CLIENT_SECRET: 'secret-1',
  }),
}));

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

function mockFetch(response: Record<string, unknown> = { processQueryKey: 'message-1' }) {
  const mock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: 'token-1', expireIn: 7200 }) })
    .mockResolvedValueOnce({ ok: true, json: async () => response });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('alert robot', () => {
  it.each(['personal', 'group'])('prevents a %s POST when shutdown occurs during token acquisition', async (channel) => {
    const { sendAlertChatMessage, sendAlertGroupMessage } = await import('./alert-robot.js');
    const stop = new AbortController();
    let reply!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { reply = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    const send = channel === 'personal'
      ? sendAlertChatMessage(['user-1'], 'reminder', 'title', stop.signal)
      : sendAlertGroupMessage('cid-group', 'reminder', ['user-1'], 'title', stop.signal);
    stop.abort();
    reply(Response.json({ accessToken: 'token-1', expireIn: 7200 }));

    await expect(send).rejects.toBe(stop.signal.reason);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://api.dingtalk.com/v1.0/oauth2/accessToken']);
  });

  it('preserves the personal markdown API used by existing budget and empty-node alerts', async () => {
    const { sendAlertChatMessage } = await import('./alert-robot.js');
    const fetchMock = mockFetch();
    await sendAlertChatMessage(['user-1'], '【预算预警】\n测试内容');
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        body: JSON.stringify({
          robotCode: 'robot-1', userIds: ['user-1'], msgKey: 'sampleMarkdown',
          msgParam: JSON.stringify({ title: '统一预警', text: '【预算预警】\n测试内容' }),
        }),
      }),
    );
  });

  it('sends group markdown with openConversationId and shares the cached application token', async () => {
    const { sendAlertChatMessage, sendAlertGroupMessage } = await import('./alert-robot.js');
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ processQueryKey: 'group-message' }) });
    await sendAlertChatMessage(['user-1'], 'Ver aprobación', 'Aprobaciones vencidas');
    await sendAlertGroupMessage('cid-group', '审批超时');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(JSON.parse(fetchMock.mock.calls[1][1].body).msgParam)).toEqual({
      title: 'Aprobaciones vencidas', text: 'Ver aprobación',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3,
      'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': 'token-1' },
        body: JSON.stringify({
          robotCode: 'robot-1', openConversationId: 'cid-group', msgKey: 'sampleMarkdown',
          msgParam: JSON.stringify({ title: '统一预警', text: '审批超时' }),
        }),
      }),
    );
  });

  it('rejects a missing group before making a network request', async () => {
    const { sendAlertGroupMessage } = await import('./alert-robot.js');
    const fetchMock = mockFetch();
    await expect(sendAlertGroupMessage(' ', 'test')).rejects.toThrow('ALERT_ROBOT_GROUP_ID_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mentions the given users through both API metadata and markdown markers', async () => {
    const { sendAlertGroupMessage } = await import('./alert-robot.js');
    const fetchMock = mockFetch();
    await sendAlertGroupMessage('cid-group', 'Ver aprobación', [' user-1 ', 'user-2', 'user-1', ' '], 'Aprobaciones vencidas');
    const payload = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(payload).toMatchObject({
      robotCode: 'robot-1', openConversationId: 'cid-group', msgKey: 'sampleMarkdown',
      atUserIds: ['user-1', 'user-2'], isAtAll: false,
    });
    expect(JSON.parse(payload.msgParam)).toEqual({ title: 'Aprobaciones vencidas', text: '@user-1 @user-2\n\nVer aprobación' });
    expect(payload).not.toHaveProperty('at');
  });

  it('sends an ordinary group message without mentions when the approver is missing', async () => {
    const { sendAlertGroupMessage } = await import('./alert-robot.js');
    const fetchMock = mockFetch();
    await sendAlertGroupMessage('cid-group', '未识别审批人', [' ', '']);
    const payload = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(payload).not.toHaveProperty('atUserIds');
    expect(payload).not.toHaveProperty('isAtAll');
    expect(JSON.parse(payload.msgParam).text).toBe('未识别审批人');
  });

  it('reports group HTTP failure without exposing the remote response', async () => {
    const { sendAlertGroupMessage } = await import('./alert-robot.js');
    const fetchMock = mockFetch();
    fetchMock.mockReset()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: 'token-1' }) })
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ secret: 'do not log' }) });
    await expect(sendAlertGroupMessage('cid-group', 'test')).rejects.toThrow('ALERT_ROBOT_GROUP_SEND_FAILED: HTTP 429');
  });

  it('does not mark a group response without a message key as successful', async () => {
    const { sendAlertGroupMessage } = await import('./alert-robot.js');
    mockFetch({ code: 'forbidden', message: 'remote diagnostic' });
    await expect(sendAlertGroupMessage('cid-group', 'test')).rejects.toThrow('ALERT_ROBOT_GROUP_SEND_RESPONSE_INVALID');
  });

  it('does not mark an invalid personal response as successful', async () => {
    const { sendAlertChatMessage } = await import('./alert-robot.js');
    mockFetch({ code: 'forbidden' });
    await expect(sendAlertChatMessage(['user-1'], 'test')).rejects.toThrow('ALERT_ROBOT_PERSONAL_SEND_RESPONSE_INVALID');
  });

  it.each(['invalidStaffIdList', 'flowControlledStaffIdList'])('reports personal partial failure (%s)', async (field) => {
    const { sendAlertChatMessage } = await import('./alert-robot.js');
    mockFetch({ [field]: ['user-1'] });
    await expect(sendAlertChatMessage(['user-1'], 'test')).rejects.toThrow('未完全送达');
  });

  it('propagates token and transport failures for the monitor to retry', async () => {
    const { sendAlertGroupMessage } = await import('./alert-robot.js');
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendAlertGroupMessage('cid-group', 'test')).rejects.toThrow('timed out');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
