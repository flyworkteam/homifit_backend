const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');

let initialized = false;

function resolveCredential() {
  const jsonRaw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw);
      return admin.credential.cert(parsed);
    } catch (_) {
      try {
        const decoded = Buffer.from(jsonRaw, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        return admin.credential.cert(parsed);
      } catch (error) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is invalid');
      }
    }
  }

  const configured = String(
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './config/firebase-service-account.json',
  ).trim();

  const projectRoot = path.resolve(__dirname, '..', '..');
  const candidates = path.isAbsolute(configured)
    ? [configured]
    : [
      path.resolve(process.cwd(), configured),
      path.resolve(projectRoot, configured),
    ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw);
      return admin.credential.cert(parsed);
    }
  }

  return admin.credential.applicationDefault();
}

function ensureFirebaseApp() {
  if (initialized) {
    return admin.app();
  }

  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: resolveCredential(),
    });
  }

  initialized = true;
  return admin.app();
}

async function verifyIdToken(idToken) {
  ensureFirebaseApp();
  return admin.auth().verifyIdToken(idToken);
}

module.exports = {
  ensureFirebaseApp,
  verifyIdToken,
  admin,
};
