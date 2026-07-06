import pg from 'pg';

async function createDatabase() {
  // 连接到默认的 postgres 数据库
  const client = new pg.Client({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'Postgres@123',
    database: 'postgres', // 连接到默认数据库
  });

  try {
    await client.connect();
    console.log('已连接到 PostgreSQL');

    // 检查数据库是否已存在
    const checkResult = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = 'dingtalk_oa'"
    );

    if (checkResult.rows.length > 0) {
      console.log('数据库 dingtalk_oa 已存在');
    } else {
      // 创建数据库
      await client.query('CREATE DATABASE dingtalk_oa');
      console.log('✅ 数据库 dingtalk_oa 创建成功');
    }
  } catch (error) {
    console.error('❌ 创建数据库失败:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

createDatabase();
