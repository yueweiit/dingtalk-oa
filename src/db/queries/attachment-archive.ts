import type pg from 'pg';
import { withClient, withTransaction } from '../pool.js';
import { extractAttachmentCandidates, type AttachmentCandidate } from '../../archive/attachment-extractor.js';
import { failureState, type PendingArchive } from '../../archive/archive-job.js';
import { AttachmentDownloadStrategiesError } from '../../archive/download-strategies.js';

const BUCKET = process.env.ARCHIVE_MINIO_BUCKET || 'dingtalk-approval-archive';

export async function upsertAttachmentCandidates(candidates: AttachmentCandidate[], client?: pg.PoolClient): Promise<number> {
  if (!candidates.length) return 0;
  const run = async (client: pg.PoolClient) => {
    for (const row of candidates) {
      await client.query(
        `INSERT INTO costing_read.attachment_archive (
           corp_id, process_instance_id, process_code, attachment_origin,
           file_id, space_id, file_name, declared_size, bucket, object_key,
           comment_user_id, comment_user_name, comment_time, comment_remark,
           thumbnail_media_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (corp_id, process_instance_id, file_id) DO UPDATE SET
           process_code = EXCLUDED.process_code,
           attachment_origin = EXCLUDED.attachment_origin,
           space_id = EXCLUDED.space_id,
           file_name = EXCLUDED.file_name,
           declared_size = EXCLUDED.declared_size,
           comment_user_id = EXCLUDED.comment_user_id,
           comment_user_name = EXCLUDED.comment_user_name,
           comment_time = EXCLUDED.comment_time,
           comment_remark = EXCLUDED.comment_remark,
           thumbnail_media_id = EXCLUDED.thumbnail_media_id,
           retired_at = NULL,
           updated_at = clock_timestamp()
         WHERE (attachment_archive.process_code, attachment_archive.attachment_origin,
                attachment_archive.space_id, attachment_archive.file_name, attachment_archive.declared_size,
                attachment_archive.comment_user_id, attachment_archive.comment_user_name,
                attachment_archive.comment_time, attachment_archive.comment_remark,
                attachment_archive.thumbnail_media_id, attachment_archive.retired_at)
           IS DISTINCT FROM
               (EXCLUDED.process_code, EXCLUDED.attachment_origin,
                EXCLUDED.space_id, EXCLUDED.file_name, EXCLUDED.declared_size,
                EXCLUDED.comment_user_id, EXCLUDED.comment_user_name,
                EXCLUDED.comment_time, EXCLUDED.comment_remark, EXCLUDED.thumbnail_media_id, NULL)`,
        [
          row.corpId, row.processInstanceId, row.processCode, row.origin,
          row.fileId, row.spaceId || null, row.fileName || null, row.declaredSize,
          BUCKET, row.objectKey, row.commentUserId || null, row.commentUserName || null,
          row.commentTime || null, row.commentRemark || null,
          row.thumbnailMediaId || null,
        ],
      );
    }
    return candidates.length;
  };
  return client ? run(client) : withTransaction(run);
}

// Each claim writes a distinct object: SQL fencing alone cannot stop a stale PUT.
export async function claimPendingAttachments(limit: number, recoveryCanariesOnly = false): Promise<PendingArchive[]> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `WITH picked AS (
         SELECT id FROM costing_read.attachment_archive
          WHERE (
            archive_status = 'pending'
            OR (archive_status = 'retry'
              AND updated_at <= now() - (LEAST(3600, 60 * (1 << attempts)) * interval '1 second'))
            OR (archive_status = 'archiving' AND claimed_at < now() - interval '15 minutes')
          )
            AND retired_at IS NULL
            AND attempts < 5
            AND (NOT $2::boolean OR recovery_canary)
          ORDER BY updated_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE costing_read.attachment_archive a
          SET archive_status = 'archiving', attempts = attempts + 1,
              claim_generation = a.claim_generation + 1,
              object_key = concat_ws('/', split_part(a.object_key, '/', 1),
                split_part(a.object_key, '/', 2), split_part(a.object_key, '/', 3))
                || '/revision-' || a.revision_generation::text
                || '/claim-' || (a.claim_generation + 1)::text,
              claimed_at = now(), updated_at = now()
         FROM picked
        WHERE a.id = picked.id
       RETURNING a.*`,
      [limit, recoveryCanariesOnly],
    );
    return rows.map(toPendingArchive);
  });
}

function toPendingArchive(row: Record<string, unknown>): PendingArchive {
  return {
    id: Number(row.id),
    corpId: String(row.corp_id),
    processInstanceId: String(row.process_instance_id),
    processCode: String(row.process_code),
    origin: row.attachment_origin as 'form' | 'comment',
    fileId: String(row.file_id),
    spaceId: String(row.space_id || ''),
    fileName: String(row.file_name || row.file_id),
    declaredSize: row.declared_size === null ? null : Number(row.declared_size),
    objectKey: String(row.object_key),
    attempts: Number(row.attempts),
    claimGeneration: String(row.claim_generation),
    thumbnailMediaId: String(row.thumbnail_media_id || ''),
    recoveryCanary: Boolean(row.recovery_canary),
  };
}

export async function markAttachmentArchived(
  id: number,
  result: {
    actualSize: number;
    etag: string;
    contentType: string;
    sha256: string;
    archiveMethod?: string;
    contentQuality?: string;
    diagnostics?: unknown[];
  },
  objectKey: string,
  claimGeneration: string,
): Promise<void> {
  await withClient((client) => client.query(
    `UPDATE costing_read.attachment_archive
        SET archive_status='archived', actual_size=$2, etag=$3, content_type=$4,
            sha256=$5, archive_method=COALESCE($6, archive_method),
            content_quality=COALESCE($7, content_quality),
            diagnostic_json=COALESCE($8::jsonb, diagnostic_json),
            failure_code=NULL, last_attempt_strategy=COALESCE($6, last_attempt_strategy),
            archived_at=now(), last_error=NULL, updated_at=now()
      WHERE id=$1 AND object_key=$9 AND claim_generation=$10
        AND retired_at IS NULL AND archive_status='archiving'`,
    [id, result.actualSize, result.etag, result.contentType, result.sha256,
      result.archiveMethod || null, result.contentQuality || null,
      result.diagnostics ? JSON.stringify(result.diagnostics) : null, objectKey, claimGeneration],
  ).then(() => undefined));
}

export async function markAttachmentFailed(
  id: number, attempts: number, error: unknown, objectKey: string, claimGeneration: string,
): Promise<void> {
  const status = failureState(attempts, error);
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics = error instanceof AttachmentDownloadStrategiesError
    ? error.diagnostics
    : error && typeof error === 'object' && 'diagnostics' in error && Array.isArray(error.diagnostics)
      ? error.diagnostics
      : [];
  const lastDiagnostic = diagnostics.at(-1);
  const lastCodedDiagnostic = [...diagnostics].reverse().find((item) => item.errorCode);
  const failureCode = lastCodedDiagnostic?.errorCode
    || (error && typeof error === 'object' && 'code' in error ? String(error.code) : 'attachment_download_failed');
  await withClient((client) => client.query(
    `UPDATE costing_read.attachment_archive
        SET archive_status=$2, last_error=$3, failure_code=$4,
            last_attempt_strategy=$5, diagnostic_json=$6::jsonb, updated_at=now()
      WHERE id=$1 AND object_key=$7 AND claim_generation=$8
        AND retired_at IS NULL AND archive_status='archiving'`,
    [id, status, message.slice(0, 4000), failureCode.slice(0, 128),
      lastDiagnostic?.strategy || null, JSON.stringify(diagnostics), objectKey, claimGeneration],
  ).then(() => undefined));
}

export async function requeueHistoricalRecoveryCanaries(limitProcesses = 5): Promise<number> {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `WITH ranked AS (
         SELECT id, created_at,
                row_number() OVER (PARTITION BY process_instance_id ORDER BY created_at, id) AS process_row
           FROM costing_read.attachment_archive
          WHERE archive_status = 'manual_required'
            AND (failure_code = 'userNotExist' OR last_error ILIKE '%userNotExist%')
       ), samples AS (
         SELECT id FROM ranked WHERE process_row=1 ORDER BY created_at, id
          LIMIT $1
       )
       UPDATE costing_read.attachment_archive a
          SET archive_status='pending', attempts=0, claimed_at=NULL,
              recovery_canary=true, last_attempt_strategy='recovery_canary_queued', updated_at=now()
         FROM samples
        WHERE a.id=samples.id`,
      [limitProcesses],
    );
    return rowCount || 0;
  });
}

export async function requeueSuccessfulRecoveryRemainders(): Promise<number> {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `WITH successful_processes AS (
         SELECT DISTINCT process_instance_id
           FROM costing_read.attachment_archive
          WHERE recovery_canary AND archive_status='archived'
       )
       UPDATE costing_read.attachment_archive a
          SET archive_status='pending', attempts=0, claimed_at=NULL,
              recovery_canary=false, last_attempt_strategy='recovery_remainder_queued', updated_at=now()
         FROM successful_processes s
        WHERE a.process_instance_id=s.process_instance_id
          AND NOT a.recovery_canary
          AND a.archive_status='manual_required'
          AND (a.failure_code='userNotExist' OR a.last_error ILIKE '%userNotExist%')`,
    );
    return rowCount || 0;
  });
}

export async function recordApiUsage(apiName: string, success: boolean): Promise<void> {
  await withClient((client) => client.query(
    `INSERT INTO costing_read.dingtalk_api_usage(api_name, success) VALUES ($1,$2)`,
    [apiName, success],
  ).then(() => undefined));
}

export async function listWhitelistedInstances(): Promise<Array<{
  corp_id: string;
  process_instance_id: string;
  process_code: string;
  raw_payload: Record<string, unknown>;
}>> {
  return withClient(async (client) => {
    const { rows } = await client.query(
      `SELECT corp_id, process_instance_id, process_code, raw_payload
         FROM costing_read.eligible_attachment_instances
        ORDER BY updated_at ASC`,
    );
    return rows;
  });
}

export async function updateArchiveHealth(params: {
  startedAt: Date;
  completed: boolean;
  success: boolean;
  scannedCount: number;
  processedCount: number;
  error?: unknown;
}): Promise<void> {
  const message = params.error instanceof Error ? params.error.message : params.error ? String(params.error) : null;
  await withClient((client: pg.PoolClient) => client.query(
    `UPDATE costing_read.archive_sync_health SET
       last_started_at=$1,
       last_completed_at=CASE WHEN $2 THEN now() ELSE last_completed_at END,
       last_success_at=CASE WHEN $3 THEN now() ELSE last_success_at END,
       last_error=$4, scanned_count=$5, processed_count=$6, updated_at=now()
     WHERE singleton=true`,
    [params.startedAt, params.completed, params.success, message?.slice(0, 4000) || null,
      params.scannedCount, params.processedCount],
  ).then(() => undefined));
}


export async function synchronizeInstanceAttachments(
  corpId: string, processInstanceId: string, client?: pg.PoolClient,
): Promise<number> {
  const run = async (c: pg.PoolClient) => {
    await c.query(`SELECT 1 FROM public.ding_approval_instance
      WHERE corp_id=$1 AND process_instance_id=$2 FOR UPDATE`, [corpId, processInstanceId]);
    const { rows } = await c.query(`SELECT * FROM costing_read.eligible_attachment_instances
      WHERE corp_id=$1 AND process_instance_id=$2`, [corpId, processInstanceId]);
    const instance = rows[0];
    const candidates = instance ? extractAttachmentCandidates({
      corpId, processInstanceId, processCode: instance.process_code,
      rawPayload: { ...instance.raw_payload, formComponentValues:
        instance.raw_payload?.formComponentValues ?? instance.raw_payload?.form_component_values ?? instance.form_component_values },
    }) : [];
    await upsertAttachmentCandidates(candidates, c);
    await c.query(`UPDATE costing_read.attachment_archive
      SET retired_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE corp_id=$1 AND process_instance_id=$2 AND retired_at IS NULL
        AND NOT (file_id = ANY($3::text[]))`, [corpId, processInstanceId, candidates.map(row => row.fileId)]);
    return candidates.length;
  };
  return client ? run(client) : withTransaction(run);
}

export async function retireIneligibleAttachments(): Promise<void> {
  const instances = await withClient(async (client) => {
    const { rows } = await client.query<{ corp_id: string; process_instance_id: string }>(`
      SELECT DISTINCT a.corp_id, a.process_instance_id FROM costing_read.attachment_archive a
      WHERE a.retired_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM costing_read.eligible_attachment_instances i
        WHERE i.corp_id=a.corp_id AND i.process_instance_id=a.process_instance_id
      )`);
    return rows;
  });
  for (const instance of instances) {
    // Re-read eligibility under the same source lock as event/backfill writers.
    await synchronizeInstanceAttachments(instance.corp_id, instance.process_instance_id);
  }
}
