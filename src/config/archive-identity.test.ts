import { describe, expect, it } from 'vitest';
import { configSchema } from './schema.js';

const environment = {
  PGUSER: 'test',
  PGPASSWORD: 'test',
  PGDATABASE: 'test',
  DINGTALK_APP_KEY: 'test',
  DINGTALK_APP_SECRET: 'test',
};

describe('archive download identity configuration', () => {
  it.each([undefined, '', ' \t '])('treats optional identity value %j as unset', (value) => {
    const config = configSchema.parse({
      ...environment,
      DINGTALK_ARCHIVE_DOWNLOAD_USER_ID: value,
      DINGTALK_ARCHIVE_DOWNLOAD_UNION_ID: value,
    });

    expect(config.DINGTALK_ARCHIVE_DOWNLOAD_USER_ID).toBeUndefined();
    expect(config.DINGTALK_ARCHIVE_DOWNLOAD_UNION_ID).toBeUndefined();
  });

  it('accepts a dedicated user with an empty unionId from an env file', () => {
    const config = configSchema.parse({
      ...environment,
      DINGTALK_ARCHIVE_DOWNLOAD_USER_ID: ' ACTIVE-USER ',
      DINGTALK_ARCHIVE_DOWNLOAD_UNION_ID: '',
    });

    expect(config.DINGTALK_ARCHIVE_DOWNLOAD_USER_ID).toBe('ACTIVE-USER');
    expect(config.DINGTALK_ARCHIVE_DOWNLOAD_UNION_ID).toBeUndefined();
  });

  it('preserves explicitly configured identities as trimmed strings', () => {
    const config = configSchema.parse({
      ...environment,
      DINGTALK_ARCHIVE_DOWNLOAD_USER_ID: ' 00123 ',
      DINGTALK_ARCHIVE_DOWNLOAD_UNION_ID: ' UNION-1 ',
    });

    expect(config.DINGTALK_ARCHIVE_DOWNLOAD_USER_ID).toBe('00123');
    expect(config.DINGTALK_ARCHIVE_DOWNLOAD_UNION_ID).toBe('UNION-1');
  });

  it.each(['DINGTALK_ARCHIVE_DOWNLOAD_USER_ID', 'DINGTALK_ARCHIVE_DOWNLOAD_UNION_ID'] as const)(
    'rejects a non-string %s', (key) => {
      const result = configSchema.safeParse({ ...environment, [key]: 123 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: [key], code: 'invalid_type' }),
        ]));
      }
    },
  );
});
