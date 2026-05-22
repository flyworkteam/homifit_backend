require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function ensureMigrationsTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function listAppliedMigrations(connection) {
  const [rows] = await connection.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((row) => row.filename));
}

async function listMigrationFiles() {
  const dir = path.resolve(__dirname, 'sql');
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

async function applyMigration(connection, filename) {
  const filePath = path.resolve(__dirname, 'sql', filename);
  const sql = fs.readFileSync(filePath, 'utf8');
  await connection.query(sql);
  await connection.query('INSERT INTO schema_migrations (filename) VALUES (?)', [filename]);
}

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number.parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });

  try {
    await ensureMigrationsTable(connection);
    const applied = await listAppliedMigrations(connection);
    const files = await listMigrationFiles();
    const pending = files.filter((file) => !applied.has(file));

    if (pending.length === 0) {
      console.log('No pending migrations.');
      return;
    }

    for (const file of pending) {
      console.log(`Applying ${file}...`);
      await applyMigration(connection, file);
    }

    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await connection.end();
  }
}

run().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
