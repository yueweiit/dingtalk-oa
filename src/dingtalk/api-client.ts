import { tokenManager } from './token-manager.js';
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

interface ApiCallOptions {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  retries?: number;
}

async function apiCall<T>(endpoint: string, options: ApiCallOptions = {}): Promise<T> {
  const { method = 'GET', body, retries = 1 } = options;

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

      if (response.status === 401 && attempt < retries) {
        tokenManager.clearToken();
        continue;
      }

      if (response.status === 429) {
        if (attempt < retries) {
          // 限流，等待后重试
          const retryAfter = response.headers.get('Retry-After');
          const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * (attempt + 1);
          console.warn(`[ApiClient] 限流 429，等待 ${waitMs}ms 后重试`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        // 最后一次重试仍被限流，抛出明确错误
        const errorBody = await response.text().catch(() => '');
        throw new Error(`API 限流: ${endpoint} HTTP 429 Retry-After=${response.headers.get('Retry-After') || 'N/A'} ${errorBody}`);
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`API 调用失败: ${endpoint} HTTP ${response.status} ${errorBody}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (attempt < retries) {
        console.warn(`[ApiClient] API 调用失败，重试 ${attempt + 1}/${retries}:`, error);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }

  throw new Error('API 调用失败: 超出重试次数');
}

export async function listProcessTemplates(userId: string): Promise<ProcessTemplate[]> {
  const token = await tokenManager.getToken();

  const url = 'https://api.dingtalk.com/v1.0/workflow/processes/templates';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': token,
    },
    body: JSON.stringify({ userId }),
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
  nextToken?: string;
  size?: number;
}): Promise<{ list: ApprovalInstance[]; totalCount: number; nextToken?: string }> {
  const body: Record<string, unknown> = {
    processCode: params.processCode,
    startTime: params.startTime.getTime(),
    endTime: params.endTime.getTime(),
    maxResults: params.size ?? 20,
  };
  if (params.nextToken) {
    body.nextToken = params.nextToken;
  }

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
