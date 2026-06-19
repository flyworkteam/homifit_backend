const jwt = require('jsonwebtoken');
const AppError = require('../utils/appError');
const { pool } = require('../config/db');
const { isEffectivelyPremium } = require('../utils/premium');

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

function isProduction() {
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

function isDevAuthEnabled() {
  // SECURITY: dev auth (the `x-user-id` header) can NEVER be enabled in
  // production, regardless of how DEV_AUTH_ENABLED / AUTH_MODE are set on
  // the server. The header lets a request claim any user id with no token,
  // so we treat "in production" as a hard, code-level kill switch rather
  // than trusting the deployment to set the env vars correctly.
  if (isProduction()) {
    return false;
  }
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
  // Defense in depth: this is the single chokepoint every dev-header auth
  // path funnels through. Hard-ignore the `x-user-id` header in production,
  // regardless of AUTH_MODE — a misconfigured prod env must never allow
  // header-based user impersonation.
  if (isProduction()) {
    return next(new AppError('Missing bearer token', 401));
  }

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

  // mode === 'auto': prefer JWT, and only fall back to the dev header
  // outside production. requireDevUser independently re-checks production,
  // so even if this branch were reached in prod the header stays ignored.
  const hasBearer = Boolean(parseBearerToken(req.headers.authorization));
  if (hasBearer) {
    return requireJwtUser(req, next);
  }

  if (isProduction() || !isDevAuthEnabled()) {
    return next(new AppError('Missing bearer token', 401));
  }

  return requireDevUser(req, next);
}

/**
 * Load the user's premium status into `req.premium` so downstream handlers
 * can branch on it cheaply. Always populates the field (never throws on
 * "no row found" — that just maps to `isPremium=false`). Call AFTER
 * `requireAuth` so `req.userId` is set.
 *
 * Result shape (mirrors `rowToStatus` in premiumController):
 *   { isPremium: bool, entitlement, productId, currentPeriodEnd, trialEnd,
 *     cancelledAt, promoDiscountPct }
 *
 * Trial handling: a backend-managed free trial sets `is_premium=1` but never
 * resets it on expiry, so `isEffectivelyPremium` gates trial rows on the live
 * `trial_end` window instead of trusting the sticky flag (see utils/premium).
 */
async function loadPremium(req, res, next) {
  void res;
  try {
    if (!req.userId) {
      req.premium = { isPremium: false };
      return next();
    }
    const [rows] = await pool.execute(
      `SELECT is_premium, entitlement, product_id, current_period_end,
              trial_end, cancelled_at, promo_discount_pct
         FROM premium_status
        WHERE user_id = ?
        LIMIT 1`,
      [req.userId],
    );
    const r = rows[0];
    req.premium = {
      isPremium: isEffectivelyPremium(r),
      entitlement: r ? r.entitlement : null,
      productId: r ? r.product_id : null,
      currentPeriodEnd: r ? r.current_period_end : null,
      trialEnd: r ? r.trial_end : null,
      cancelledAt: r ? r.cancelled_at : null,
      promoDiscountPct: r ? r.promo_discount_pct : 0,
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Hard-gate a route behind an active premium subscription. Use as the
 * middleware AFTER `requireAuth` for any endpoint that should be Pro-only
 * (e.g., advanced plan creation, 30-day plans, premium templates).
 *
 *   router.post('/something', requireAuth, requirePremium, controller.do);
 *
 * Returns 402 PAYMENT_REQUIRED so the client can route the user to the
 * paywall. The body includes a `lockedReason` for the UI to surface.
 */
async function requirePremium(req, res, next) {
  try {
    if (!req.premium) {
      await new Promise((resolve, reject) => {
        loadPremium(req, res, (err) => (err ? reject(err) : resolve()));
      });
    }
    if (req.premium && req.premium.isPremium) {
      return next();
    }
    return next(
      new AppError('Premium subscription required', 402, {
        lockedReason: 'premium_required',
      }),
    );
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  requireAuth,
  loadPremium,
  requirePremium,
};
