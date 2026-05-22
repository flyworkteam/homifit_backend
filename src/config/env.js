const fs = require('node:fs');
const path = require('node:path');

const requiredEnv = [
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
];

function resolveFirebaseServiceAccountPath() {
  const configured = String(
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './config/firebase-service-account.json',
  ).trim();

  if (path.isAbsolute(configured)) {
    return configured;
  }

  const projectRoot = path.resolve(__dirname, '..', '..');
  const candidates = [
    path.resolve(process.cwd(), configured),
    path.resolve(projectRoot, configured),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function isValidFirebaseServiceAccountJson(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    return false;
  }

  try {
    JSON.parse(value);
    return true;
  } catch (_) {
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      JSON.parse(decoded);
      return true;
    } catch (_) {
      return false;
    }
  }
}

function parseAllowedOrigins() {
  return String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function assertProductionOriginRules() {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const origins = parseAllowedOrigins();
  if (origins.length === 0) {
    throw new Error('ALLOWED_ORIGINS is required in production');
  }

  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch (error) {
      throw new Error(`Invalid ALLOWED_ORIGINS entry: ${origin}`);
    }

    if (parsed.protocol !== 'https:') {
      throw new Error(`ALLOWED_ORIGINS must use https in production: ${origin}`);
    }

    if (origin !== parsed.origin) {
      throw new Error(`ALLOWED_ORIGINS entries must be canonical origins without path/query: ${origin}`);
    }
  }
}

function assertProductionSecrets() {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const firebasePath = String(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim();
  const firebaseJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  const resolvedPath = resolveFirebaseServiceAccountPath();
  const hasCredentialFile = fs.existsSync(resolvedPath);

  if (firebaseJson && !isValidFirebaseServiceAccountJson(firebaseJson)) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is invalid');
  }

  if (!firebaseJson && firebasePath && !hasCredentialFile) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_PATH does not exist');
  }

  if (!firebasePath && !firebaseJson && !hasCredentialFile) {
    throw new Error(
      'Missing Firebase admin credentials: set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON',
    );
  }
}

function validateEnv() {
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase() || 'development';
  if (!new Set(['development', 'test', 'production']).has(nodeEnv)) {
    throw new Error('NODE_ENV must be one of: development, test, production');
  }

  const missing = requiredEnv.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const mode = String(process.env.AUTH_MODE || '').trim().toLowerCase();
  if (mode && !new Set(['jwt', 'dev', 'auto']).has(mode)) {
    throw new Error('AUTH_MODE must be one of: jwt, dev, auto');
  }

  const devAuthEnabled = String(process.env.DEV_AUTH_ENABLED || '').trim().toLowerCase() === 'true';
  if (nodeEnv === 'production' && devAuthEnabled) {
    throw new Error('DEV_AUTH_ENABLED must be false in production');
  }

  if (nodeEnv === 'production' && (mode === 'dev' || mode === 'auto')) {
    throw new Error('AUTH_MODE must be jwt in production');
  }

  const resolvedMode = mode || 'jwt';
  const requiresJwtSecret = resolvedMode === 'jwt' || (nodeEnv === 'production' && resolvedMode === 'auto');
  if (requiresJwtSecret && !process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required when AUTH_MODE is jwt');
  }

  assertProductionOriginRules();
  assertProductionSecrets();
}

module.exports = {
  validateEnv,
};
