import { tokenManager } from './token-manager.js';
import { recordApiUsage } from '../db/queries/attachment-archive.js';
import {
  listProcessTemplatesResponseSchema,
  searchInstancesResponseSchema,
  getInstanceResponseSchema,
  getUserResponseSchema,
  type ProcessTemplate,
  type ApprovalInstance,
  type ApprovalInstanceDetail,
  type UserInfo,
} from './types.js';
import type { DownloadResource } from '../archive/download-strategies.js';

const BASE_URL = 'https://api.dingtalk.com/v1.0';

// Simple token-bucket rate limiter
class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms
  private lastRefill: number;

  constructor(maxTokens: number, refillPerSecond: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillPerSecond / 1000;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// 钉钉 API 限流：40次/秒，留余量用 30
const rateLimiter = new RateLimiter(10, 30);

export async function acquireDingTalkApiSlot(): Promise<void> {
  await rateLimiter.acquire();
}

interface ApiCallOptions {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  retries?: number;
  usageName?: string;
  validate?: (data: Record<string, unknown>) => void;
}

class DingTalkApiError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'DingTalkApiError';
  }
}

async function apiCall<T>(endpoint: string, options: ApiCallOptions = {}): Promise<T> {
  const { method = 'GET', body, retries = 1, usageName = endpoint.split('?', 1)[0], validate } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await rateLimiter.acquire();
    const token = await tokenManager.getToken();
    try {
      const response = await fetch(`${BASE_URL}${endpoint}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const responseText = await response.text().catch(() => '');
      if (!response.ok) {
        if (response.status === 401) tokenManager.clearToken();
        throw new DingTalkApiError(
          `API 调用失败: ${usageName} HTTP ${response.status} ${responseText}`,
          response.status === 401 || response.status === 429 || response.status >= 500,
        );
      }
      const data = responseText ? JSON.parse(responseText) as Record<string, unknown> : {};
      try {
        ensureDingTalkResult(data);
        validate?.(data);
      } catch (error) {
        throw new DingTalkApiError(error instanceof Error ? error.message : String(error), false);
      }
      await recordApiUsage(usageName, true).catch((error) => {
        console.warn('[ApiClient] API 调用计数写入失败:', error);
      });
      return data as T;
    } catch (error) {
      await recordApiUsage(usageName, false).catch((recordError) => {
        console.warn('[ApiClient] API 调用计数写入失败:', recordError);
      });
      const retryable = !(error instanceof DingTalkApiError) || error.retryable;
      if (retryable && attempt < retries) {
        console.warn(`[ApiClient] API 调用失败，重试 ${attempt + 1}/${retries}:`, error);
        const waitMs = error instanceof DingTalkApiError && error.message.includes('HTTP 429')
          ? 1000 * (attempt + 1)
          : 1000 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      throw error;
    }
  }

  throw new Error('API 调用失败: 超出重试次数');
}

function resultObject(data: Record<string, unknown>): Record<string, unknown> {
  const result = data.result;
  return result && typeof result === 'object' ? result as Record<string, unknown> : data;
}

function ensureDingTalkResult(data: Record<string, unknown>): Record<string, unknown> {
  const errorCode = data.errcode ?? data.code;
  if (
    data.success === false
    || (errorCode !== undefined && errorCode !== null && ![0, '0', 'ok', 'OK'].includes(errorCode as never))
  ) {
    throw new Error(JSON.stringify({
      code: errorCode,
      message: data.errmsg ?? data.message ?? '钉钉接口调用失败',
    }));
  }
  return resultObject(data);
}

function numericSpaceId(value: string): number {
  const normalized = String(value || '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error('钉钉 spaceId 不是有效整数');
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new Error('钉钉 spaceId 超出 JavaScript 安全整数范围');
  return parsed;
}

async function legacyApiCall(
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = await tokenManager.getToken();
  const url = `https://oapi.dingtalk.com${endpoint}?access_token=${encodeURIComponent(token)}`;
  let usageRecorded = false;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!response.ok) throw new Error(`API 调用失败: ${endpoint} HTTP ${response.status} ${text}`);
    ensureDingTalkResult(data);
    await recordApiUsage(endpoint, true).catch(() => undefined);
    usageRecorded = true;
    return data;
  } catch (error) {
    if (!usageRecorded) await recordApiUsage(endpoint, false).catch(() => undefined);
    throw error;
  }
}

function extractDownloadResource(data: Record<string, unknown>): DownloadResource {
  let body = resultObject(data);
  const downloadInfo = body.downloadInfo ?? body.download_info;
  if (downloadInfo && typeof downloadInfo === 'object') {
    body = { ...body, ...downloadInfo as Record<string, unknown> };
  }
  const signature = body.headerSignatureInfo ?? body.header_signature_info;
  const signatureBody = signature && typeof signature === 'object'
    ? signature as Record<string, unknown>
    : {};
  const urls = body.resourceUrls ?? body.resource_urls ?? signatureBody.resourceUrls ?? signatureBody.resource_urls;
  const firstUrl = Array.isArray(urls) ? urls[0] : '';
  const uri = String(
    body.downloadUri ?? body.download_uri ?? body.downloadUrl ?? body.download_url
    ?? body.resourceUrl ?? body.resource_url ?? body.url ?? firstUrl ?? '',
  ).trim();
  const headerValue = body.headers ?? body.downloadHeaders ?? body.download_headers
    ?? signatureBody.headers ?? signatureBody.downloadHeaders ?? signatureBody.download_headers;
  const headers = headerValue && typeof headerValue === 'object'
    ? Object.fromEntries(Object.entries(headerValue as Record<string, unknown>)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => [key, String(value)]))
    : {};
  if (!uri) throw new Error('钉钉附件下载响应中没有下载地址');
  return { uri, headers };
}

export async function listProcessTemplates(userId: string): Promise<ProcessTemplate[]> {
  const token = await tokenManager.getToken();

  const url = `https://api.dingtalk.com/v1.0/workflow/processes/managements/templates?userId=${encodeURIComponent(userId)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': token,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`API 调用失败: ${url} HTTP ${response.status} ${errorBody}`);
  }

  const data: unknown = await response.json();

  const parsed = listProcessTemplatesResponseSchema.parse(data);
  return parsed.result.map(t => ({
    name: t.name || t.flowTitle || '',
    processCode: t.processCode,
    description: t.description,
  }));
}

export async function searchInstances(params: {
  processCode: string;
  startTime: Date;
  endTime: Date;
  nextToken?: string | number;
  size?: number;
}): Promise<{ list: string[]; totalCount?: number; nextToken?: string | number }> {
  const body: Record<string, unknown> = {
    processCode: params.processCode,
    startTime: params.startTime.getTime(),
    endTime: params.endTime.getTime(),
    maxResults: params.size ?? 20,
    nextToken: params.nextToken ?? 0,
  };

  const data = await apiCall<unknown>('/workflow/processes/instanceIds/query', {
    method: 'POST',
    body,
  });

  const parsed = searchInstancesResponseSchema.parse(data);
  return parsed.result;
}

export async function getInstance(processInstanceId: string): Promise<ApprovalInstanceDetail> {
  const data = await apiCall<unknown>(`/workflow/processInstances?processInstanceId=${processInstanceId}`);

  const parsed = getInstanceResponseSchema.parse(data);
  return parsed.result;
}

export async function getApprovalAttachmentDownloadUrl(
  processInstanceId: string,
  fileId: string,
): Promise<string> {
  const data = await apiCall<Record<string, unknown>>('/workflow/processInstances/spaces/files/urls/download', {
    method: 'POST',
    body: { processInstanceId, fileId },
  });
  const result = (data.result && typeof data.result === 'object' ? data.result : data) as Record<string, unknown>;
  const uri = String(
    result.downloadUri ?? result.downloadUrl ?? result.download_uri ?? result.download_url ?? '',
  ).trim();
  if (!uri) throw new Error('钉钉附件下载地址响应中没有 downloadUri');
  return uri;
}

export async function getLegacyApprovalAttachmentDownload(
  processInstanceId: string,
  fileId: string,
): Promise<DownloadResource> {
  const data = await legacyApiCall('/topapi/processinstance/file/url/get', {
    request: { process_instance_id: processInstanceId, file_id: fileId },
  });
  ensureDingTalkResult(data);
  return extractDownloadResource(data);
}

export async function getLegacyApprovalAttachmentSpaceId(
  processInstanceId: string,
  fileId: string,
  userId: string,
): Promise<string> {
  void processInstanceId;
  void fileId;
  const data = await legacyApiCall('/topapi/processinstance/cspace/info', {
    user_id: userId,
  });
  const body = ensureDingTalkResult(data);
  const spaceId = String(body.space_id ?? body.spaceId ?? '').trim();
  if (!spaceId) throw new Error('钉钉 cspace 接口未返回 spaceId');
  return spaceId;
}

export async function authorizeLegacyApprovalAttachment(
  fileId: string,
  spaceId: string,
  userId: string,
): Promise<void> {
  await legacyApiCall('/topapi/process/dentry/auth', {
    request: {
      file_infos: [{ file_id: fileId, space_id: numericSpaceId(spaceId) }],
      userid: userId,
    },
  });
}

export async function authorizeApprovalAttachmentDownload(
  fileId: string,
  spaceId: string,
  userId: string,
): Promise<void> {
  const data = await apiCall<Record<string, unknown>>('/workflow/processInstances/spaces/files/authDownload', {
    method: 'POST',
    body: { userId, fileInfos: [{ spaceId: numericSpaceId(spaceId), fileId }] },
  });
  ensureDingTalkResult(data);
}

export async function getUserUnionId(userId: string): Promise<string> {
  const data = await legacyApiCall('/topapi/v2/user/get', { userid: userId, language: 'zh_CN' });
  const body = ensureDingTalkResult(data);
  const unionId = String(body.unionid ?? body.unionId ?? '').trim();
  if (!unionId) throw new Error('钉钉用户详情响应中没有 unionId');
  return unionId;
}

export async function getStorageDentryDownloadInfo(
  spaceId: string,
  dentryId: string,
  unionId: string,
): Promise<DownloadResource> {
  const endpoint = `/storage/spaces/${encodeURIComponent(spaceId)}/dentries/${encodeURIComponent(dentryId)}/downloadInfos/query?unionId=${encodeURIComponent(unionId)}`;
  const data = await apiCall<Record<string, unknown>>(endpoint, {
    method: 'POST',
    body: { option: { version: 1, preferIntranet: false } },
    usageName: '/storage/spaces/{spaceId}/dentries/{dentryId}/downloadInfos/query',
  });
  ensureDingTalkResult(data);
  return extractDownloadResource(data);
}

export async function listStorageDentries(
  spaceId: string,
  unionId: string,
): Promise<Array<{ id: string; name: string }>> {
  const endpoint = `/storage/spaces/${encodeURIComponent(spaceId)}/dentries?parentId=0&maxResults=100&unionId=${encodeURIComponent(unionId)}`;
  const data = await apiCall<Record<string, unknown>>(endpoint, {
    usageName: '/storage/spaces/{spaceId}/dentries',
  });
  const body = ensureDingTalkResult(data);
  const raw = body.dentries ?? body.list ?? body.items ?? body.results ?? body.data ?? [];
  return (Array.isArray(raw) ? raw : []).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const id = String(row.dentryId ?? row.dentry_id ?? row.fileId ?? row.file_id ?? row.id ?? '').trim();
    const name = String(row.name ?? row.fileName ?? row.file_name ?? row.title ?? '').trim();
    return id ? [{ id, name }] : [];
  });
}

export async function getDriveFileDownloadInfo(
  spaceId: string,
  fileId: string,
  unionId: string,
): Promise<DownloadResource> {
  const endpoint = `/drive/spaces/${encodeURIComponent(spaceId)}/files/${encodeURIComponent(fileId)}/downloadInfos?unionId=${encodeURIComponent(unionId)}`;
  const data = await apiCall<Record<string, unknown>>(endpoint, {
    usageName: '/drive/spaces/{spaceId}/files/{fileId}/downloadInfos',
  });
  ensureDingTalkResult(data);
  return extractDownloadResource(data);
}

export async function getStorageThumbnailDownload(
  spaceId: string,
  dentryId: string,
  unionId: string,
): Promise<DownloadResource> {
  const endpoint = `/storage/spaces/${encodeURIComponent(spaceId)}/thumbnails/query?unionId=${encodeURIComponent(unionId)}`;
  const data = await apiCall<Record<string, unknown>>(endpoint, {
    method: 'POST',
    body: { dentryIds: [dentryId] },
    usageName: '/storage/spaces/{spaceId}/thumbnails/query',
    validate: (responseData) => {
      const body = ensureDingTalkResult(responseData);
      const rawItems = body.resultItems ?? body.result_items ?? body.items ?? body.list ?? [];
      const items = Array.isArray(rawItems) ? rawItems : [rawItems];
      const failed = items.find((value) => value && typeof value === 'object'
        && (value as Record<string, unknown>).success === false) as Record<string, unknown> | undefined;
      if (failed) {
        throw new Error(JSON.stringify({
          code: failed.errorCode ?? failed.error_code ?? 'thumbnail_failed',
          message: failed.errorMessage ?? failed.error_message ?? '钉钉缩略图生成失败',
        }));
      }
    },
  });
  const body = ensureDingTalkResult(data);
  const rawItems = body.resultItems ?? body.result_items ?? body.items ?? body.list ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  for (const value of items) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const thumbnail = row.thumbnail && typeof row.thumbnail === 'object'
      ? row.thumbnail as Record<string, unknown>
      : row;
    try {
      return extractDownloadResource(thumbnail);
    } catch {
      // Continue looking for another matching result item.
    }
  }
  throw new Error('钉钉缩略图响应中没有可下载地址');
}

export async function getThumbnailMediaDownload(mediaId: string): Promise<DownloadResource> {
  const token = await tokenManager.getToken();
  return {
    uri: `https://oapi.dingtalk.com/media/downloadFile?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`,
    headers: {},
  };
}

export async function getUser(userId: string): Promise<UserInfo> {
  const token = await tokenManager.getToken();
  const url = `https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${token}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userid: userId, language: 'zh_CN' }),
  });

  if (!response.ok) {
    throw new Error(`oapi 调用失败: HTTP ${response.status}`);
  }

  const data: unknown = await response.json();
  const dataObj = data as Record<string, unknown>;

  if (dataObj.errcode && dataObj.errcode !== 0) {
    throw new Error(`oapi 错误: ${dataObj.errcode} ${dataObj.errmsg}`);
  }

  const parsed = getUserResponseSchema.parse(data);
  return parsed.result;
}

/**
 * 获取部门列表（递归获取所有子部门）
 */
export async function listDepartments(deptId: number = 1): Promise<{ dept_id: number; name: string }[]> {
  const token = await tokenManager.getToken();
  const url = `https://oapi.dingtalk.com/topapi/v2/department/listsub?access_token=${token}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dept_id: deptId }),
  });

  if (!response.ok) {
    throw new Error(`oapi 调用失败: HTTP ${response.status}`);
  }

  const data: unknown = await response.json();
  const dataObj = data as Record<string, unknown>;

  if (dataObj.errcode && dataObj.errcode !== 0) {
    throw new Error(`oapi 错误: ${dataObj.errcode} ${dataObj.errmsg}`);
  }

  return (dataObj.result as { dept_id: number; name: string }[]) || [];
}

/**
 * 获取部门下的用户列表（分页）
 */
export async function listUsers(deptId: number, cursor: number = 0, size: number = 100): Promise<{ hasMore: boolean; list: Record<string, unknown>[]; nextCursor: number }> {
  const token = await tokenManager.getToken();
  const url = `https://oapi.dingtalk.com/topapi/v2/user/list?access_token=${token}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dept_id: deptId, cursor, size }),
  });

  if (!response.ok) {
    throw new Error(`oapi 调用失败: HTTP ${response.status}`);
  }

  const data: unknown = await response.json();
  const dataObj = data as Record<string, unknown>;

  if (dataObj.errcode && dataObj.errcode !== 0) {
    throw new Error(`oapi 错误: ${dataObj.errcode} ${dataObj.errmsg}`);
  }

  const result = dataObj.result as Record<string, unknown> | undefined;
  return {
    hasMore: (result?.has_more as boolean) ?? false,
    list: (result?.list as Record<string, unknown>[]) ?? [],
    nextCursor: (result?.next_cursor as number) ?? 0,
  };
}

// 防限流辅助函数
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
