import { config as loadEnv } from 'dotenv';
import { configSchema, type Config } from './schema.js';

loadEnv();

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    console.error('❌ 环境变量校验失败:\n' + errors);
    process.exit(1);
  }

  _config = result.data;
  return _config;
}

export type { Config };
