import { withClient } from '../pool.js';

export interface BusinessEntityApprover {
  userId: string;
  name: string | null;
  priority: number;
}

export interface ResolvedBusinessEntity {
  businessCode: string;
  name: string;
}

export async function resolveBusinessEntities(
  corpId: string,
  values: string[]
): Promise<ResolvedBusinessEntity[]> {
  return withClient(async (client) => {
    const { rows } = await client.query<{
      business_code: string;
      name: string;
    }>(
      `SELECT business_code, name
       FROM ding_business_entity
       WHERE corp_id = $1
         AND is_active = true
         AND (business_code = ANY($2) OR name = ANY($2))
       ORDER BY business_code`,
      [corpId, values]
    );
    return rows.map((row) => ({ businessCode: row.business_code, name: row.name }));
  });
}

export async function findBusinessEntityApprovers(
  corpId: string,
  businessCodes: string[]
): Promise<BusinessEntityApprover[]> {
  return withClient(async (client) => {
    const { rows } = await client.query<{
      user_id: string;
      name: string | null;
      priority: number;
    }>(
      `SELECT DISTINCT ON (a.user_id) a.user_id, u.name, a.priority
       FROM ding_business_entity_approver a
       LEFT JOIN ding_user_snapshot u
         ON u.corp_id = a.corp_id
        AND u.user_id = a.user_id
        AND u.is_current = true
        AND u.fetch_status = 'success'
       WHERE a.corp_id = $1
         AND a.business_code = ANY($2)
         AND a.is_active = true
       ORDER BY a.user_id, a.priority ASC`,
      [corpId, businessCodes]
    );
    return rows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      priority: row.priority,
    })).sort((left, right) => left.priority - right.priority || left.userId.localeCompare(right.userId));
  });
}
