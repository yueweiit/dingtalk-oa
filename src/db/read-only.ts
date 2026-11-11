import type pg from 'pg';
import { withClient } from './pool.js';

export async function withReadOnlyTransaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withClient(async client => {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query("SET LOCAL statement_timeout = '15s'");
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
