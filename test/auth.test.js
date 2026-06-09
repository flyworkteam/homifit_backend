'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { requireAuth } = require('../src/middleware/auth');

// Snapshot the process env once so each case runs in isolation and we never
// leak NODE_ENV / AUTH_MODE between tests.
const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(resetEnv);

// Express lowercases header names; the middleware reads `x-user-id` and
// `authorization` in lowercase, so the mock req mirrors that.
function makeReq(headers = {}) {
  return { headers };
}

// requireAuth signals success/failure via next(err). Resolve to the (possibly
// mutated) req plus whatever error was passed to next.
function runAuth(req) {
  return new Promise((resolve) => {
    requireAuth(req, {}, (err) => resolve({ err: err || null, req }));
  });
}

test('x-user-id dev header is IGNORED in production (AUTH_MODE=auto)', async () => {
  process.env.NODE_ENV = 'production';
  process.env.AUTH_MODE = 'auto';
  process.env.DEV_AUTH_ENABLED = 'true';

  const { err, req } = await runAuth(makeReq({ 'x-user-id': '1' }));

  assert.ok(err, 'request must be rejected, not authenticated');
  assert.equal(err.statusCode, 401);
  assert.equal(req.userId, undefined, 'must NOT impersonate user 1');
  assert.equal(req.authMethod, undefined);
});

test('x-user-id dev header is IGNORED in production regardless of AUTH_MODE (dev)', async () => {
  // Defense in depth: even if AUTH_MODE is mistakenly left as "dev" in prod,
  // the header must never authenticate anyone.
  process.env.NODE_ENV = 'production';
  process.env.AUTH_MODE = 'dev';
  process.env.DEV_AUTH_ENABLED = 'true';

  const { err, req } = await runAuth(makeReq({ 'x-user-id': '7' }));

  assert.ok(err);
  assert.equal(err.statusCode, 401);
  assert.equal(req.userId, undefined);
});

test('production detection tolerates casing/whitespace ("  Production ")', async () => {
  process.env.NODE_ENV = '  Production ';
  process.env.AUTH_MODE = 'auto';
  process.env.DEV_AUTH_ENABLED = 'true';

  const { err, req } = await runAuth(makeReq({ 'x-user-id': '1' }));

  assert.ok(err, 'a sloppily-cased NODE_ENV must still count as production');
  assert.equal(req.userId, undefined);
});

test('x-user-id dev header IS honored outside production (development)', async () => {
  // Guard against over-correcting: local dev must keep working.
  process.env.NODE_ENV = 'development';
  process.env.AUTH_MODE = 'auto';
  process.env.DEV_AUTH_ENABLED = 'true';

  const { err, req } = await runAuth(makeReq({ 'x-user-id': '42' }));

  assert.equal(err, null);
  assert.equal(req.userId, 42);
  assert.equal(req.authMethod, 'dev-header');
});

test('a valid JWT still authenticates in production', async () => {
  process.env.NODE_ENV = 'production';
  process.env.AUTH_MODE = 'jwt';
  process.env.JWT_SECRET = 'test-secret';
  delete process.env.JWT_ISSUER;
  delete process.env.JWT_AUDIENCE;

  const token = jwt.sign({ userId: 99 }, 'test-secret');
  const { err, req } = await runAuth(makeReq({ authorization: `Bearer ${token}` }));

  assert.equal(err, null);
  assert.equal(req.userId, 99);
  assert.equal(req.authMethod, 'jwt');
});

test('x-user-id with no bearer token is rejected under production JWT mode', async () => {
  // The recommended prod config: AUTH_MODE=jwt. Sending only x-user-id must 401.
  process.env.NODE_ENV = 'production';
  process.env.AUTH_MODE = 'jwt';
  process.env.JWT_SECRET = 'test-secret';

  const { err, req } = await runAuth(makeReq({ 'x-user-id': '1' }));

  assert.ok(err);
  assert.equal(err.statusCode, 401);
  assert.equal(req.userId, undefined);
});
