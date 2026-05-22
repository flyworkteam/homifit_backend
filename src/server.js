require('dotenv').config();

const app = require('./app');
const { validateEnv } = require('./config/env');
const { testConnection } = require('./config/db');

async function start() {
  validateEnv();
  await testConnection();

  const port = Number.parseInt(process.env.PORT || '3000', 10);
  app.listen(port, () => {
    console.log(`HomiFit backend is running on port ${port}`);
  });
}

start().catch((error) => {
  console.error('Failed to start backend:', error.message);
  process.exit(1);
});
