import { getConfig } from '../config/index.js';
import { tokenResponseSchema, type TokenResponse } from './types.js';

const TOKEN_EXPIRE_BUFFER_MS = 5 * 60 * 1000; // 5 分钟缓冲

class TokenManager {
  private token: string | null = null;
  private expiresAt: number = 0;
  private refreshPromise: Promise<string> | null = null;

  async getToken(): Promise<string> {
    // token 有效，直接返回
    if (this.token && Date.now() < this.expiresAt - TOKEN_EXPIRE_BUFFER_MS) {
      return this.token;
    }

    // 已有刷新请求在进行中，等待其完成
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    // 发起刷新
    this.refreshPromise = this.doRefresh();

    try {
      return await this.refreshPromise;
    } catch (error) {
      // doRefresh 内部已尝试 fallback 到旧 token；
      // 如果走到这里说明旧 token 也不可用，传播错误
      throw error;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<string> {
    const config = getConfig();

    try {
      const url = `https://oapi.dingtalk.com/gettoken?appkey=${config.DINGTALK_APP_KEY}&appsecret=${config.DINGTALK_APP_SECRET}`;
      const response = await fetch(url, { method: 'GET' });

      if (!response.ok) {
        throw new Error(`Token 刷新失败: HTTP ${response.status}`);
      }

      const data = await response.json();
      const parsed = tokenResponseSchema.parse(data);

      if (parsed.errcode && parsed.errcode !== 0) {
        throw new Error(`Token 刷新失败: ${parsed.errcode} ${parsed.errmsg}`);
      }

      this.token = parsed.access_token;
      this.expiresAt = Date.now() + parsed.expires_in * 1000;

      console.log('[TokenManager] Token 刷新成功，过期时间:', new Date(this.expiresAt).toISOString());

      return this.token;
    } catch (error) {
      console.error('[TokenManager] Token 刷新失败:', error);

      // 如果还有未过期的 token，继续使用
      if (this.token && Date.now() < this.expiresAt) {
        console.warn('[TokenManager] 使用未过期的旧 token');
        return this.token;
      }

      throw error;
    }
  }

  clearToken(): void {
    this.token = null;
    this.expiresAt = 0;
  }
}

export const tokenManager = new TokenManager();
