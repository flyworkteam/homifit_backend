#!/usr/bin/env node
require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number.parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  try {
    const [tables] = await conn.query(
      `SELECT TABLE_NAME, TABLE_ROWS, ENGINE
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [process.env.DB_NAME],
    );
    console.log(`\n${tables.length} tables in ${process.env.DB_NAME}:\n`);
    for (const t of tables) {
      const [cols] = await conn.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [process.env.DB_NAME, t.TABLE_NAME],
      );
      console.log(`  ${t.TABLE_NAME.padEnd(36)} ${String(cols[0].n).padStart(3)} cols  (${t.ENGINE})`);
    }
  } finally {
    await conn.end();
  }
})();
