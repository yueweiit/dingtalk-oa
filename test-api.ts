import { tokenManager } from './src/dingtalk/token-manager.js';
import { getConfig } from './src/config/index.js';

getConfig();

async function main() {
  const token = await tokenManager.getToken();
  console.log('Token:', token.slice(0, 20) + '...');

  // 测试 v1.0 API
  console.log('\n--- 测试 v1.0 GET ---');
  const url1 = 'https://api.dingtalk.com/v1.0/process/instance/get?processInstanceId=test';
  const r1 = await fetch(url1, { headers: { Authorization: `Bearer ${token}` } });
  console.log('Status:', r1.status);
  console.log('Body:', await r1.text());

  // 测试 oapi POST
  console.log('\n--- 测试 oapi POST ---');
  const url2 = `https://oapi.dingtalk.com/topapi/processinstance/get?access_token=${token}`;
  const r2 = await fetch(url2, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ processInstanceId: 'test' }),
  });
  console.log('Status:', r2.status);
  console.log('Body:', await r2.text());
}

main().catch(console.error);
