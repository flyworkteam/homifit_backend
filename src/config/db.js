const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number.parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number.parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: '+00:00',
  dateStrings: true,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  connectTimeout: Number.parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '10000', 10),
});

const transientDbErrorCodes = new Set([
  'ECONNRESET',
  'PROTOCOL_CONNECTION_LOST',
  'ETIMEDOUT',
  'EPIPE',
]);

function isTransientDbError(error) {
  if (!error) {
    return false;
  }

  if (transientDbErrorCodes.has(error.code)) {
    return true;
  }

  const message = String(error.message || '').toUpperCase();
  return message.includes('ECONNRESET') || message.includes('PROTOCOL_CONNECTION_LOST');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeWithRetry(sql, params = [], maxAttempts = 2) {
  let attempt = 1;
  while (true) {
    try {
      return await pool.execute(sql, params);
    } catch (error) {
      const shouldRetry = attempt < maxAttempts && isTransientDbError(error);
      if (!shouldRetry) {
        throw error;
      }

      await sleep(120 * attempt);
      attempt += 1;
    }
  }
}

async function testConnection() {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
  } finally {
    conn.release();
  }
}

module.exports = {
  pool,
  testConnection,
  executeWithRetry,
};
