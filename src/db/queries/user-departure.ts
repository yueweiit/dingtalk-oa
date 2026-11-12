import type pg from 'pg';
import { withClient, withTransaction } from '../pool.js';
import { departureFromApproval, departureProcessCodes, type DepartureSource } from '../../normalize/user-departure.js';

async function findNameCandidate(client: pg.PoolClient, corpId: string, employeeName: string, dingtalkName: string) {
  const { rows } = await client.query<{ user_id: string }>(
    `WITH names AS (SELECT lower($2::text) AS employee, lower($3::text) AS dingtalk),
          candidates AS (
       SELECT s.user_id, lower(btrim(s.name)) AS name
       FROM ding_user_snapshot s CROSS JOIN names n
       WHERE s.corp_id = $1 AND s.fetch_status = 'success'
         AND n.employee <> n.dingtalk AND lower(btrim(s.name)) <> 'unknown'
         AND lower(btrim(s.name)) IN (n.employee, n.dingtalk)
     )
     SELECT min(user_id) AS user_id FROM candidates
     HAVING count(DISTINCT name) = 2 AND count(DISTINCT user_id) = 1`,
    [corpId, employeeName, dingtalkName],
  );
  return rows[0]?.user_id ?? null;
}

type IdentityMethod = 'originator' | 'manual';

function namesConflict(saved: string | null, current: string | null): boolean {
  const normalize = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return saved !== null && current !== null && normalize(saved) !== normalize(current);
}

/** Archive and backfill both hold the source row lock while reconciling the derived record. */
export async function syncApprovalDeparture(
  client: pg.PoolClient,
  source: DepartureSource,
  options: { dryRun?: boolean; confirmedUserId?: string } = {},
) {
  const departure = departureFromApproval(source);
  if (!departure) {
    if (options.confirmedUserId) throw new Error('DEPARTURE_CONFIRMATION_REQUIRES_APPROVED_MX_APPROVAL');
    return null;
  }
  const { region, departedOn, submitterId, submitterIds, approvedDetail } = departure;
  let { employeeName, dingtalkName } = departure;
  const { corp_id: corpId, process_instance_id: instanceId, process_code: processCode } = source;
  const confirmed = options.confirmedUserId;
  const proxyIds = submitterIds.length ? submitterIds : [source.originator_user_id];
  if (confirmed && (region !== 'MX' || !approvedDetail || (!employeeName && !dingtalkName) || proxyIds.includes(confirmed))) {
    throw new Error('DEPARTURE_CONFIRMATION_REQUIRES_MX_EMPLOYEE_IDENTITY');
  }

  let userId = region === 'CN' ? submitterId : null;
  let method: IdentityMethod | null = userId ? 'originator' : null;
  let candidateUserId: string | null = null;
  let identityReviewRequired = false;
  const { rows: [previous] } = await client.query<{
    employee_name: string | null;
    dingtalk_name: string | null;
    user_id: string | null;
    identity_method: IdentityMethod | null;
    identity_review_required: boolean;
  }>(
    `SELECT employee_name, dingtalk_name, user_id, identity_method, identity_review_required
       FROM ding_user_departure
      WHERE corp_id = $1 AND source_process_instance_id = $2 AND source_process_code = $3`,
    [corpId, instanceId, processCode],
  );

  if (region === 'MX') {
    if (confirmed) {
      userId = confirmed;
      method = 'manual';
      if (confirmed === previous?.user_id) {
        if (!namesConflict(previous.employee_name, employeeName)) employeeName = previous.employee_name ?? employeeName;
        if (!namesConflict(previous.dingtalk_name, dingtalkName)) dingtalkName = previous.dingtalk_name ?? dingtalkName;
      }
    } else if (previous?.identity_method === 'manual') {
      userId = previous.user_id;
      method = 'manual';
      identityReviewRequired = previous.identity_review_required || submitterIds.some(id => id === userId) ||
        (approvedDetail && (namesConflict(previous.employee_name, employeeName) || namesConflict(previous.dingtalk_name, dingtalkName)));
      employeeName = previous.employee_name;
      dingtalkName = previous.dingtalk_name;
    } else {
      if (approvedDetail && employeeName && dingtalkName) {
        const candidate = await findNameCandidate(client, corpId, employeeName, dingtalkName);
        if (candidate && /^\S{1,128}$/.test(candidate) && !proxyIds.includes(candidate)) candidateUserId = candidate;
      }
      employeeName ??= previous?.employee_name ?? null;
      dingtalkName ??= previous?.dingtalk_name ?? null;
    }
  } else if (!userId || userId === previous?.user_id) {
    employeeName = previous?.employee_name ?? employeeName;
  }

  if (!options.dryRun) {
    await client.query(
      `INSERT INTO ding_user_departure AS d
         (corp_id, source_process_instance_id, source_process_code, region,
          employee_name, dingtalk_name, departed_on, user_id, identity_method, candidate_user_id, identity_review_required)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (corp_id, source_process_instance_id) DO UPDATE SET
         source_process_code = EXCLUDED.source_process_code, region = EXCLUDED.region,
         employee_name = EXCLUDED.employee_name, dingtalk_name = EXCLUDED.dingtalk_name,
         departed_on = EXCLUDED.departed_on, user_id = EXCLUDED.user_id,
         identity_method = EXCLUDED.identity_method, candidate_user_id = EXCLUDED.candidate_user_id,
         identity_review_required = EXCLUDED.identity_review_required, updated_at = now()
       WHERE (d.source_process_code, d.region, d.employee_name, d.dingtalk_name, d.departed_on, d.user_id,
              d.identity_method, d.candidate_user_id, d.identity_review_required)
         IS DISTINCT FROM (EXCLUDED.source_process_code, EXCLUDED.region, EXCLUDED.employee_name,
                           EXCLUDED.dingtalk_name, EXCLUDED.departed_on, EXCLUDED.user_id, EXCLUDED.identity_method,
                           EXCLUDED.candidate_user_id, EXCLUDED.identity_review_required)`,
      [corpId, instanceId, processCode, region, employeeName, dingtalkName, departedOn, userId, method,
        candidateUserId, identityReviewRequired],
    );
  }
  return { userId, departedOn, identityMethod: method, candidateUserId, identityReviewRequired };
}

/** Local archive only. Apply is idempotent, with one transaction per bounded batch. */
export async function backfillUserDepartures(corpId: string, options: {
  dryRun?: boolean; instanceId?: string; confirmedUserId?: string;
} = {}) {
  const { instanceId, confirmedUserId, dryRun = true } = options;
  if (!corpId.trim() || corpId.length > 64 || (instanceId !== undefined && (!instanceId.trim() || instanceId.length > 128))) {
    throw new Error('DEPARTURE_BACKFILL_SCOPE_INVALID');
  }
  if (confirmedUserId !== undefined && (dryRun || !instanceId || !/^\S{1,128}$/.test(confirmedUserId))) {
    throw new Error('DEPARTURE_CONFIRMATION_REQUIRES_SINGLE_INSTANCE_AND_APPLY');
  }
  const result = { scanned: 0, approved: 0, identified: 0, pendingIdentity: 0, candidates: 0, pendingDate: 0, dryRun };
  let cursor = '';
  while (true) {
    const lastId = await (dryRun ? withClient : withTransaction)(async client => {
      const { rows } = await client.query<DepartureSource>(
        `SELECT corp_id, process_instance_id, process_code, status, result, deleted_at,
                originator_user_id, raw_payload
         FROM ding_approval_instance
         WHERE corp_id = $1 AND process_code = ANY($2::varchar[]) AND deleted_at IS NULL
           AND process_instance_id > $3 AND ($4::varchar IS NULL OR process_instance_id = $4)
         ORDER BY process_instance_id LIMIT 100${dryRun ? '' : ' FOR UPDATE'}`,
        [corpId, departureProcessCodes, cursor, instanceId ?? null],
      );
      for (const row of rows) {
        result.scanned++;
        const departure = await syncApprovalDeparture(client, row, { dryRun, confirmedUserId });
        if (!departure) continue;
        result.approved++;
        if (departure.userId && !departure.identityReviewRequired) result.identified++;
        else result.pendingIdentity++;
        if (departure.candidateUserId) result.candidates++;
        if (!departure.departedOn) result.pendingDate++;
      }
      return rows.at(-1)?.process_instance_id;
    });
    if (!lastId || instanceId) break;
    cursor = lastId;
  }
  if (confirmedUserId && !result.identified) throw new Error('DEPARTURE_CONFIRMATION_SOURCE_NOT_FOUND');
  return result;
}

/** The source must still be an approved, un-deleted instance when the refresh is checked. */
export async function hasEffectiveUserDeparture(corpId: string, userId: string, at?: Date): Promise<boolean> {
  return withClient(async client => {
    const { rows } = await client.query<{ effective: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ding_user_departure d
         JOIN ding_approval_instance i ON i.corp_id = d.corp_id
           AND i.process_instance_id = d.source_process_instance_id AND i.process_code = d.source_process_code
         WHERE d.corp_id = $1 AND d.user_id = $2 AND d.departed_on IS NOT NULL AND NOT d.identity_review_required
           AND d.departed_on <= (COALESCE($3::timestamptz, statement_timestamp()) AT TIME ZONE
             CASE d.region WHEN 'CN' THEN 'Asia/Shanghai' ELSE 'America/Mexico_City' END)::date
           AND i.deleted_at IS NULL AND upper(btrim(i.status)) = 'COMPLETED' AND lower(btrim(i.result)) = 'agree'
       ) AS effective`,
      [corpId, userId, at ?? null],
    );
    return rows[0].effective;
  });
}
