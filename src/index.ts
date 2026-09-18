import { getConfig } from './config/index.js';
import { getPool, closePool } from './db/pool.js';
import { ensureCorpConfigTable } from './db/queries/corp-config.js';
import { createApp } from './app.js';
import { initKafkaProducer, closeKafkaProducer } from './kafka/producer.js';
import { initKafkaConsumer, closeKafkaConsumer } from './kafka/consumer.js';
import { startEventOutbox, stopEventOutbox } from './kafka/event-outbox.js';
import { startStreamListener, stopStreamListener } from './dingtalk/stream-listener.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { processApprovalMessage } from './normalize/orchestrator.js';
import { tokenManager } from './dingtalk/token-manager.js';
import { syncTemplateNames } from './jobs/sync-template-names.js';
import { startPackingRefreshWorker, stopPackingRefreshWorker } from './packing/refresh-worker.js';
import { startApprovalRepairWorker, stopApprovalRepairWorker } from './jobs/approval-repair-worker.js';

async function main() {
  console.log('🚀 钉钉审批数据归档系统启动中...');

  // 1. 加载配置（zod 校验）
  const config = getConfig();
  console.log('✅ 配置加载成功');

  // 2. 初始化 DB 连接池
  const pool = getPool();
  console.log('✅ 数据库连接池初始化成功');

  // 2.5 确保 corp_config 表存在
  await ensureCorpConfigTable();
  console.log('✅ 企业配置表初始化成功');

  // 3. 初始化 Kafka Producer。Kafka 暂时不可用时不阻断主服务，事件由 outbox 持久化。
  try {
    await initKafkaProducer();
    console.log('✅ Kafka Producer 初始化成功');
  } catch (error) {
    console.warn('⚠️ Kafka Producer 初始化失败，服务继续启动，待 Kafka 恢复后重启应用投递 outbox:', error);
  }

  // 3.5 启动事件缓冲区
  startEventOutbox();

  // 4. 启动 Fastify 服务（健康检查立即可用）
  const app = await createApp();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  console.log(`✅ Fastify 服务启动成功，端口: ${config.PORT}`);

  // 5. API 权限自检
  try {
    await tokenManager.getToken();
    console.log('✅ API 权限自检成功');
  } catch (error) {
    console.warn('⚠️ API 权限自检失败，但不阻断启动:', error);
  }

  // 5.5 同步模板名称（补填 name 为空的模板）
  syncTemplateNames().catch((error) => {
    console.warn('⚠️ 模板名称同步失败，但不阻断启动:', error);
  });

  // 6. 启动 Kafka Consumer。启动时 Kafka 不可用时保留 API/Stream/outbox 能力。
  try {
    await initKafkaConsumer(async (message) => {
      await processApprovalMessage(message);
    });
    console.log('✅ Kafka Consumer 启动成功');
  } catch (error) {
    console.warn('⚠️ Kafka Consumer 启动失败，服务继续启动；Kafka 恢复后请重启应用:', error);
  }

  // 7. 启动 Stream Listener
  try {
    await startStreamListener();
    console.log('✅ Stream Listener 启动成功');
  } catch (error) {
    console.warn('⚠️ Stream Listener 启动失败，但不阻断启动:', error);
  }

  // 8. 启动 Cron 调度器
  startScheduler();
  console.log('✅ Cron 调度器启动成功');

  startPackingRefreshWorker();
  console.log('✅ 装箱工作簿刷新任务启动成功');

  startApprovalRepairWorker();
  console.log('✅ 审批缺口修复任务启动成功');

  // 9. 注册优雅关闭
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n${signal} 收到，开始优雅关闭...`);

    const shutdownTimeout = setTimeout(() => {
      console.error('❌ 优雅关闭超时（30s），强制退出');
      process.exit(1);
    }, 30_000);
    shutdownTimeout.unref();

    try {
      stopScheduler();
      console.log('✅ 定时任务已停止');

      stopPackingRefreshWorker();
      console.log('✅ 装箱工作簿刷新任务已停止');

      stopApprovalRepairWorker();
      console.log('✅ 审批缺口修复任务已停止');

      stopEventOutbox();

      await stopStreamListener();
      console.log('✅ Stream Listener 已停止');

      await closeKafkaConsumer();
      console.log('✅ Kafka Consumer 已停止');

      await closeKafkaProducer();
      console.log('✅ Kafka Producer 已关闭');

      await app.close();
      console.log('✅ Fastify 已关闭');

      await closePool();
      console.log('✅ 数据库连接池已关闭');

      console.log('✅ 优雅关闭完成');
    } catch (error) {
      console.error('❌ 优雅关闭失败:', error);
      process.exit(1);
    }
    // 所有资源已关闭，事件循环将自然退出
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  console.log('🎉 钉钉审批数据归档系统启动完成');
}

main().catch((error) => {
  console.error('❌ 启动失败:', error);
  process.exit(1);
});
