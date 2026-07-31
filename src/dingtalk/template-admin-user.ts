import type { Config } from '../config/index.js';

export function getTemplateAdminUserId(config: Pick<Config, 'DINGTALK_TEMPLATE_ADMIN_USER_ID'>): string | null {
  const userId = config.DINGTALK_TEMPLATE_ADMIN_USER_ID?.trim();
  return userId || null;
}
