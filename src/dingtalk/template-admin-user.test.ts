import { describe, expect, it } from 'vitest';
import { getTemplateAdminUserId } from './template-admin-user.js';

describe('getTemplateAdminUserId', () => {
  it('uses only the explicitly configured template administrator user ID', () => {
    expect(getTemplateAdminUserId({ DINGTALK_TEMPLATE_ADMIN_USER_ID: '17600775501628783' }))
      .toBe('17600775501628783');
  });

  it('returns null when the fixed template administrator user ID is absent', () => {
    expect(getTemplateAdminUserId({ DINGTALK_TEMPLATE_ADMIN_USER_ID: undefined })).toBeNull();
  });
});
