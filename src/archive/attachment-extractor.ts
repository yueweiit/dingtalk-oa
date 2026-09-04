export type AttachmentOrigin = 'form' | 'comment';

export interface AttachmentCandidate {
  corpId: string;
  processInstanceId: string;
  processCode: string;
  origin: AttachmentOrigin;
  fileId: string;
  spaceId: string;
  fileName: string;
  declaredSize: number | null;
  objectKey: string;
  thumbnailMediaId?: string;
  commentUserId?: string;
  commentUserName?: string;
  commentTime?: string;
  commentRemark?: string;
}

interface ExtractParams {
  corpId: string;
  processInstanceId: string;
  processCode: string;
  rawPayload: Record<string, unknown>;
}

const FILE_ID_KEYS = ['fileId', 'file_id', 'fileID', 'mediaId', 'media_id'];
const FILE_NAME_KEYS = ['fileName', 'file_name', 'filename', 'name', 'title'];
const SPACE_ID_KEYS = ['spaceId', 'space_id', 'spaceID'];
const FILE_SIZE_KEYS = ['fileSize', 'file_size', 'size'];

function firstValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
  }
  return undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || !['[', '{'].includes(text[0])) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function findFiles(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) findFiles(item, found);
    return found;
  }
  if (!parsed || typeof parsed !== 'object') return found;

  const record = parsed as Record<string, unknown>;
  if (firstValue(record, FILE_ID_KEYS) !== undefined) found.push(record);
  for (const [key, nested] of Object.entries(record)) {
    // thumbnail.mediaId is a preview reference of the parent file, not another attachment.
    if (key === 'thumbnail') continue;
    if (nested && (typeof nested === 'object' || typeof nested === 'string')) findFiles(nested, found);
  }
  return found;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function sizeValue(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

export function buildObjectKey(corpId: string, processInstanceId: string, fileId: string): string {
  return [corpId, processInstanceId, fileId].map((part) => encodeURIComponent(part)).join('/');
}

function toCandidate(
  params: ExtractParams,
  file: Record<string, unknown>,
  origin: AttachmentOrigin,
  comment?: Record<string, unknown>,
): AttachmentCandidate | null {
  const fileId = stringValue(firstValue(file, FILE_ID_KEYS));
  if (!fileId) return null;
  const thumbnail = file.thumbnail && typeof file.thumbnail === 'object'
    ? file.thumbnail as Record<string, unknown>
    : {};
  const thumbnailMediaId = stringValue(
    thumbnail.authMediaId ?? thumbnail.mediaId ?? file.authMediaId ?? file.auth_media_id,
  );
  return {
    corpId: params.corpId,
    processInstanceId: params.processInstanceId,
    processCode: params.processCode,
    origin,
    fileId,
    spaceId: stringValue(firstValue(file, SPACE_ID_KEYS)),
    fileName: stringValue(firstValue(file, FILE_NAME_KEYS)) || fileId,
    declaredSize: sizeValue(firstValue(file, FILE_SIZE_KEYS)),
    objectKey: buildObjectKey(params.corpId, params.processInstanceId, fileId),
    ...(thumbnailMediaId ? { thumbnailMediaId } : {}),
    ...(comment
      ? {
          commentUserId: stringValue(comment.userId ?? comment.user_id ?? comment.operatorUserId),
          commentUserName: stringValue(comment.userName ?? comment.user_name ?? comment.operatorName),
          commentTime: stringValue(comment.date ?? comment.createTime ?? comment.create_time ?? comment.operationTime),
          commentRemark: stringValue(comment.remark ?? comment.comment ?? comment.content),
        }
      : {}),
  };
}

export function extractAttachmentCandidates(params: ExtractParams): AttachmentCandidate[] {
  const rows: AttachmentCandidate[] = [];
  const payload = params.rawPayload || {};
  const formComponents = (payload.formComponentValues ?? payload.form_component_values ?? []) as unknown;
  const components = Array.isArray(formComponents) ? formComponents : [];
  for (const component of components) {
    for (const file of findFiles(component)) {
      const candidate = toCandidate(params, file, 'form');
      if (candidate) rows.push(candidate);
    }
  }

  const operations = (payload.operationRecords ?? payload.operation_records ?? payload.comments ?? []) as unknown;
  if (Array.isArray(operations)) {
    for (const operation of operations) {
      if (!operation || typeof operation !== 'object') continue;
      const record = operation as Record<string, unknown>;
      for (const file of findFiles(record.attachments ?? record.operationAttachments ?? record.files ?? record)) {
        const candidate = toCandidate(params, file, 'comment', record);
        if (candidate) rows.push(candidate);
      }
    }
  }

  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.fileId)) return false;
    seen.add(row.fileId);
    return true;
  });
}
