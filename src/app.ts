import Fastify from 'fastify';
import cors from '@fastify/cors';
import { getConfig } from './config/index.js';
import { webhookRoutes } from './webhook/index.js';
import { getPool } from './db/pool.js';
import { tokenManager } from './dingtalk/token-manager.js';

export async function createApp() {
  const config = getConfig();

  const isDev = process.env.NODE_ENV !== 'production';

  const fastify = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(isDev && {
        transport: {
          target: 'pino-pretty',
          options: {
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        },
      }),
    },
  });

  // 注册 CORS
  await fastify.register(cors, {
    origin: true,
    credentials: true,
  });

  // 注册 Webhook 路由
  await fastify.register(webhookRoutes);

  // 健康检查：存活检查（仅判断服务进程是否活着）
  fastify.get('/health/live', async (request, reply) => {
    return reply.send({ status: 'ok' });
  });

  // 健康检查：就绪检查（检查 DB、Token 是否可用）
  fastify.get('/health/ready', async (request, reply) => {
    const checks = {
      database: false,
      token: false,
    };

    // 检查数据库连接
    try {
      const pool = getPool();
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      checks.database = true;
    } catch (error) {
      fastify.log.error({ err: error }, '数据库健康检查失败');
    }

    // 检查 Token
    try {
      await tokenManager.getToken();
      checks.token = true;
    } catch (error) {
      fastify.log.error({ err: error }, 'Token 健康检查失败');
    }

    const isReady = checks.database && checks.token;

    return reply.status(isReady ? 200 : 503).send({
      status: isReady ? 'ready' : 'not_ready',
      checks,
    });
  });

  // 指标端点
  fastify.get('/metrics', async (request, reply) => {
    // 这里可以扩展为更详细的指标
    const metrics = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    };

    return reply.send(metrics);
  });

  return fastify;
}
