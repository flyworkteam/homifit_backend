const jwt = require('jsonwebtoken');
const AppError = require('../utils/appError');

function parseBearerToken(authorization) {
  if (!authorization || typeof authorization !== 'string') {
    return null;
  }

  const [scheme, token] = authorization.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return null;
  }

  return token.trim();
}

function parseStrictPositiveInt(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function isDevAuthEnabled() {
  return String(process.env.DEV_AUTH_ENABLED || '').trim().toLowerCase() === 'true';
}

function getAuthMode() {
  const mode = String(process.env.AUTH_MODE || '').trim().toLowerCase();
  if (mode === 'jwt' || mode === 'dev' || mode === 'auto') {
    return mode;
  }

  return 'jwt';
}

function requireDevUser(req, next) {
  if (!isDevAuthEnabled()) {
    return next(new AppError('Dev auth is not enabled', 503));
  }

  const rawUserId = req.headers['x-user-id'];
  const userId = parseStrictPositiveInt(rawUserId);

  if (userId == null) {
    return next(new AppError('Invalid user id', 401));
  }

  req.userId = userId;
  req.authMethod = 'dev-header';
  return next();
}

function requireJwtUser(req, next) {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) {
    return next(new AppError('Missing bearer token', 401));
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return next(new AppError('JWT is not configured', 503));
  }

  let payload;
  try {
    const verifyOptions = {};
    if (process.env.JWT_ISSUER) {
      verifyOptions.issuer = process.env.JWT_ISSUER;
    }
    if (process.env.JWT_AUDIENCE) {
      verifyOptions.audience = process.env.JWT_AUDIENCE;
    }

    payload = jwt.verify(token, secret, verifyOptions);
  } catch (error) {
    return next(new AppError('Invalid or expired token', 401));
  }

  const rawUserId = payload.userId ?? payload.sub;
  const userId = parseStrictPositiveInt(rawUserId);
  if (userId == null) {
    return next(new AppError('Token does not contain a valid user id', 401));
  }

  req.userId = userId;
  req.authMethod = 'jwt';
  req.firebaseUid = payload.firebase_uid || null;
  return next();
}

function requireAuth(req, res, next) {
  void res;
  const mode = getAuthMode();

  if (mode === 'jwt') {
    return requireJwtUser(req, next);
  }

  if (mode === 'dev') {
    return requireDevUser(req, next);
  }

  const hasBearer = Boolean(parseBearerToken(req.headers.authorization));
  if (hasBearer) {
    return requireJwtUser(req, next);
  }

  if (process.env.NODE_ENV === 'production' || !isDevAuthEnabled()) {
    return next(new AppError('Missing bearer token', 401));
  }

  return requireDevUser(req, next);
}

module.exports = {
  requireAuth,
};
