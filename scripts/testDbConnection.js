#!/usr/bin/env node
require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

(async () => {
  console.log('Connecting to', process.env.DB_HOST, 'as', process.env.DB_USER, 'db=', process.env.DB_NAME);
  let conn;
  try {
    conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number.parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectTimeout: 10000,
    });
    const [rows] = await conn.query('SELECT VERSION() AS version, DATABASE() AS db, USER() AS user');
    console.log('OK:', rows[0]);
  } catch (err) {
    console.error('FAIL:', err.code, err.message);
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
})();
