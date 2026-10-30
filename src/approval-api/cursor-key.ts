import { createHmac } from 'node:crypto';
import type { Config } from '../config/schema.js';

/** Stable across workers/restarts, with a domain separate from DingTalk authentication. */
export function resolveCursorSecret(config: Pick<Config, 'APPROVAL_READ_API_CURSOR_SECRET' | 'DINGTALK_APP_SECRET'>): Buffer {
  const secret = config.APPROVAL_READ_API_CURSOR_SECRET ?? config.DINGTALK_APP_SECRET;
  if (!secret) throw new Error('CURSOR_SIGNING_KEY_REQUIRED');
  return createHmac('sha256', secret).update('dingtalk-oa/approval-read/cursor/v2').digest();
}
