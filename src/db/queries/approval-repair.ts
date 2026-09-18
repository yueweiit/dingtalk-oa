import type pg from 'pg';
import { withClient, withTransaction } from '../pool.js';

export interface ApprovalRepairRequest {
  id: number;
  corpId: string;
  processInstanceId: string;
  expectedBusinessId: string;
  expectedProcessCode: string;
  expectedPurpose: 'international_logistics' | 'purchase_expense';
  attempts: number;
}

function repairRequest(row: Record<string, unknown>): ApprovalRepairRequest {
  return {
    id: Number(row.id),
    corpId: String(row.corp_id),
    processInstanceId: String(row.process_instance_id),
    expectedBusinessId: String(row.expected_business_id),
    expectedProcessCode: String(row.expected_process_code),
    expectedPurpose: row.expected_purpose as ApprovalRepairRequest['expectedPurpose'],
    attempts: Number(row.attempts),
  };
}

export async function claimNextApprovalRepairRequest(): Promise<ApprovalRepairRequest | null> {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE costing_read.approval_repair_request
          SET status='manual_required', completed_at=now(), next_attempt_at=NULL,
              error_code='worker_interrupted',
              error_message='worker stopped after the final claim; manual retry is required',
              updated_at=now()
        WHERE status='running'
          AND attempts >= 3
          AND claimed_at < now() - interval '15 minutes'`,
    );
    const { rows } = await client.query(
      `WITH picked AS (
         SELECT id
           FROM costing_read.approval_repair_request
          WHERE (
            status='pending'
            OR (status='retry' AND COALESCE(next_attempt_at, now()) <= now())
            OR (status='running' AND claimed_at < now() - interval '15 minutes')
          )
            AND attempts < 3
          ORDER BY requested_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE costing_read.approval_repair_request request
          SET status='running', attempts=request.attempts + 1,
              claimed_at=now(), next_attempt_at=NULL, updated_at=now()
         FROM picked
        WHERE request.id=picked.id
       RETURNING request.*`,
    );
    return rows[0] ? repairRequest(rows[0]) : null;
  });
}

function errorDetails(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : 'approval_repair_failed';
  return { code: code.slice(0, 256), message: message.slice(0, 4000) };
}

export async function markApprovalRepairSuccess(id: number, fetched: {
  fetchedBusinessId: string;
  fetchedProcessCode: string;
}): Promise<void> {
  await withClient((client) => client.query(
    `UPDATE costing_read.approval_repair_request
        SET status='success', completed_at=now(), next_attempt_at=NULL,
            error_code=NULL, error_message=NULL,
            fetched_business_id=$2, fetched_process_code=$3, updated_at=now()
      WHERE id=$1`,
    [id, fetched.fetchedBusinessId, fetched.fetchedProcessCode],
  ).then(() => undefined));
}

export async function markApprovalRepairFailure(
  id: number,
  error: unknown,
  retryable: boolean,
): Promise<void> {
  const details = errorDetails(error);
  await withClient((client: pg.PoolClient) => client.query(
    `UPDATE costing_read.approval_repair_request
        SET status=CASE WHEN $2 AND attempts < 3 THEN 'retry' ELSE 'manual_required' END,
            next_attempt_at=CASE WHEN $2 AND attempts < 3
              THEN now() + (LEAST(300, 5 * power(2, GREATEST(attempts - 1, 0))) * interval '1 second')
              ELSE NULL END,
            completed_at=CASE WHEN $2 AND attempts < 3 THEN NULL ELSE now() END,
            error_code=$3, error_message=$4, updated_at=now()
      WHERE id=$1`,
    [id, retryable, details.code, details.message],
  ).then(() => undefined));
}
