import { describe, expect, it } from 'vitest';
import { configSchema } from './schema.js';

const required = { PGUSER: 'test', PGPASSWORD: 'test', PGDATABASE: 'test', DINGTALK_APP_KEY: 'test', DINGTALK_APP_SECRET: 'test' };
describe('automatic archive configuration', () => {
  it('requires explicit activation and bounds polling and download deadlines', () => {
    expect(configSchema.parse(required)).toMatchObject({ ARCHIVE_WORKER_ENABLED: false,
      ARCHIVE_WORKER_POLL_MS: 5000, ARCHIVE_DOWNLOAD_TIMEOUT_MS: 60000, ARCHIVE_STORAGE_TIMEOUT_MS: 60000 });
    expect(configSchema.parse({ ...required, ARCHIVE_WORKER_ENABLED: 'true' }).ARCHIVE_WORKER_ENABLED).toBe(true);
  });
  it.each([{ ARCHIVE_WORKER_POLL_MS: 999 }, { ARCHIVE_DOWNLOAD_TIMEOUT_MS: 0 }, { ARCHIVE_DOWNLOAD_TIMEOUT_MS: 300001 },
    { ARCHIVE_STORAGE_TIMEOUT_MS: 999 }, { ARCHIVE_STORAGE_TIMEOUT_MS: 300001 }])
    ('rejects invalid limits %j', override => {
      expect(configSchema.safeParse({ ...required, ...override }).success).toBe(false);
    });
});
