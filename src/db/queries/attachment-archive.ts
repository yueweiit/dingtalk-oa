import type pg from 'pg';
import { withClient, withTransaction } from '../pool.js';
import type { AttachmentCandidate } from '../../archive/attachment-extractor.js';
import { failureState, type PendingArchive } from '../../archive/archive-job.js';
import { AttachmentDownloadStrategiesError } from '../../archive/download-strategies.js';

const BUCKET = process.env.ARCHIVE_MINIO_BUCKET || 'dingtalk-approval-archive';

export async function upsertAttachmentCandidates(candidates: AttachmentCandidate[]): Promise<number> {
  if (!candidates.length) return 0;
  return withTransaction(async (client) => {
    for (const row of candidates) {
      await client.query(
        `INSERT INTO costing_read.attachment_archive (
           corp_id, process_instance_id, process_code, attachment_origin,
           file_id, space_id, file_name, declared_size, bucket, object_key,
           comment_user_id, comment_user_name, comment_time, comment_remark,
           thumbnail_media_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (corp_id, process_instance_id, file_id) DO UPDATE SET
           space_id = COALESCE(EXCLUDED.space_id, costing_read.attachment_archive.space_id),
           file_name = COALESCE(EXCLUDED.file_name, costing_read.attachment_archive.file_name),
           declared_size = COALESCE(EXCLUDED.declared_size, costing_read.attachment_archive.declared_size),
           comment_user_id = COALESCE(EXCLUDED.comment_user_id, costing_read.attachment_archive.comment_user_id),
           comment_user_name = COALESCE(EXCLUDED.comment_user_name, costing_read.attachment_archive.comment_user_name),
           comment_time = COALESCE(EXCLUDED.comment_time, costing_read.attachment_archive.comment_time),
           comment_remark = COALESCE(EXCLUDED.comment_remark, costing_read.attachment_archive.comment_remark),
           thumbnail_media_id = COALESCE(EXCLUDED.thumbnail_media_id, costing_read.attachment_archive.thumbnail_media_id),
           updated_at = now()`,
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
  });
}

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
            AND attempts < 5
            AND (NOT $2::boolean OR recovery_canary)
          ORDER BY updated_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE costing_read.attachment_archive a
          SET archive_status = 'archiving', attempts = attempts + 1,
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
): Promise<void> {
  await withClient((client) => client.query(
    `UPDATE costing_read.attachment_archive
        SET archive_status='archived', actual_size=$2, etag=$3, content_type=$4,
            sha256=$5, archive_method=COALESCE($6, archive_method),
            content_quality=COALESCE($7, content_quality),
            diagnostic_json=COALESCE($8::jsonb, diagnostic_json),
            failure_code=NULL, last_attempt_strategy=COALESCE($6, last_attempt_strategy),
            archived_at=now(), last_error=NULL, updated_at=now()
      WHERE id=$1`,
    [id, result.actualSize, result.etag, result.contentType, result.sha256,
      result.archiveMethod || null, result.contentQuality || null,
      result.diagnostics ? JSON.stringify(result.diagnostics) : null],
  ).then(() => undefined));
}

export async function markAttachmentFailed(id: number, attempts: number, error: unknown): Promise<void> {
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
      WHERE id=$1`,
    [id, status, message.slice(0, 4000), failureCode.slice(0, 128),
      lastDiagnostic?.strategy || null, JSON.stringify(diagnostics)],
  ).then(() => undefined));
}

export async function requeueHistoricalRecoveryCanaries(limitProcesses = 5): Promise<number> {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `WITH samples AS (
         SELECT DISTINCT ON (process_instance_id) id
           FROM costing_read.attachment_archive
          WHERE archive_status = 'manual_required'
            AND (failure_code = 'userNotExist' OR last_error ILIKE '%userNotExist%')
          ORDER BY process_instance_id, id
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
         FROM costing_read.approval_instances_v1
         JOIN costing_read.allowed_process_template USING (process_code)
        WHERE archive_attachments
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
