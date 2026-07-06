import crypto from 'crypto';
import { getConfig } from '../config/index.js';

/**
 * 验证钉钉 Webhook 签名
 * 钉钉官方加解密机制：https://open.dingtalk.com/document/orgapp/verify-the-signature
 */
export function verifySignature(params: {
  timestamp: string;
  signature: string;
  body: string;
}): boolean {
  const config = getConfig();

  if (!config.WEBHOOK_TOKEN || !config.WEBHOOK_AES_KEY) {
    throw new Error('[Signature] Webhook 配置缺失 (WEBHOOK_TOKEN / WEBHOOK_AES_KEY)，拒绝请求');
  }

  const { timestamp, signature, body } = params;

  const signString = `${timestamp}\n${config.WEBHOOK_TOKEN}`;
  const hmac = crypto.createHmac('sha256', config.WEBHOOK_AES_KEY);
  hmac.update(signString);
  const expectedSignature = hmac.digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * 解密钉钉 Webhook 消息体
 * 钉钉使用 AES-256-CBC，IV 为 AES Key 的前 16 字节
 * 参考：https://open.dingtalk.com/document/orgapp/receive-message
 */
export function decryptMessage(encryptedData: string): string {
  const config = getConfig();

  if (!config.WEBHOOK_AES_KEY) {
    throw new Error('Webhook AES Key 未配置');
  }

  // AES Key 是 Base64 编码的 32 字节密钥
  const key = Buffer.from(config.WEBHOOK_AES_KEY, 'base64');

  // 钉钉约定 IV 为 AES Key 的前 16 字节
  const iv = key.subarray(0, 16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
