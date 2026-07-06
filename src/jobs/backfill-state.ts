import {
  createCursor,
  updateCursor,
  findRunningCursor,
  findCursorByWindow,
  getCursorsByProcessCode,
} from '../db/queries/backfill-cursor.js';
import type { BackfillCursor } from '../db/types.js';

export async function createBackfillCursor(params: {
  corp_id: string;
  process_code: string;
  window_start: Date;
  window_end: Date;
}): Promise<BackfillCursor> {
  return createCursor(params);
}

export async function updateBackfillCursor(params: {
  id: bigint;
  status?: string;
  cursor_offset?: number;
  processed_count?: number;
  finished_at?: Date;
  error_message?: string;
}): Promise<void> {
  return updateCursor(params);
}

export async function getRunningCursor(
  corp_id: string,
  process_code: string
): Promise<BackfillCursor | null> {
  return findRunningCursor(corp_id, process_code);
}

export async function getCursorByWindow(
  corp_id: string,
  process_code: string,
  window_start: Date,
  window_end: Date
): Promise<BackfillCursor | null> {
  return findCursorByWindow(corp_id, process_code, window_start, window_end);
}

export async function getCursorHistory(
  corp_id: string,
  process_code: string
): Promise<BackfillCursor[]> {
  return getCursorsByProcessCode(corp_id, process_code);
}
