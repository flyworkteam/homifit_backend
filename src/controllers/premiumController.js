const crypto = require('node:crypto');
const AppError = require('../utils/appError');
const { pool } = require('../config/db');

function rowToStatus(r) {
  if (!r) {
    return {
      isPremium: false,
      entitlement: null,
      productId: null,
      store: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEnd: null,
      cancelledAt: null,
      promoDiscountPct: 0,
    };
  }
  return {
    isPremium: Boolean(r.is_premium),
    entitlement: r.entitlement,
    productId: r.product_id,
    store: r.store,
    currentPeriodStart: r.current_period_start,
    currentPeriodEnd: r.current_period_end,
    trialEnd: r.trial_end,
    cancelledAt: r.cancelled_at,
    promoDiscountPct: r.promo_discount_pct,
  };
}

async function getStatus(req, res, next) {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM premium_status WHERE user_id = ? LIMIT 1',
      [req.userId],
    );
    res.json({ success: true, data: rowToStatus(rows[0] || null), error: null });
  } catch (error) {
    next(error);
  }
}

// Per `docs/HomiFit – Premium Paket Özellikleri.docx`:
//   "HomiFit ilk kez indirildiğinde kullanıcıya sınırlı ücretsiz kullanım
//    hakkı tanımlanır. (1 gün)"
// Duration is in milliseconds (1 day).
const TRIAL_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Start a 1-day backend-managed free trial for the current user. Idempotent:
 *   - If the user already has an active subscription → 400 (no need).
 *   - If a trial was already started (active OR expired) → return the same
 *     `trial_end` and no-op. Free trials are one-shot per user.
 *   - Otherwise insert / update `premium_status` with
 *       is_premium = 1
 *       entitlement = 'trial'
 *       trial_end = NOW + 1 day
 *
 * Called by the client once per install at end-of-onboarding (or on first
 * authenticated launch if the user skipped onboarding).
 */
async function startTrial(req, res, next) {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM premium_status WHERE user_id = ? LIMIT 1',
      [req.userId],
    );
    const existing = rows[0] || null;

    if (existing && existing.is_premium && existing.entitlement &&
        existing.entitlement !== 'trial') {
      // Already a paying subscriber — nothing to do.
      return res.json({
        success: true,
        data: { ...rowToStatus(existing), alreadyPremium: true },
        error: null,
      });
    }

    if (existing && existing.trial_end) {
      // Trial was already started for this user — return the same window.
      // Don't extend; that would defeat the one-shot purpose.
      return res.json({
        success: true,
        data: { ...rowToStatus(existing), trialAlreadyUsed: true },
        error: null,
      });
    }

    const now = new Date();
    const trialEnd = new Date(now.getTime() + TRIAL_DURATION_MS);
    await pool.execute(
      `INSERT INTO premium_status (user_id, is_premium, entitlement,
          current_period_start, current_period_end, trial_end, store)
       VALUES (?, 1, 'trial', ?, ?, ?, 'manual')
       ON DUPLICATE KEY UPDATE
         is_premium = 1,
         entitlement = 'trial',
         current_period_start = VALUES(current_period_start),
         current_period_end = VALUES(current_period_end),
         trial_end = VALUES(trial_end),
         store = 'manual'`,
      [req.userId, now, trialEnd, trialEnd],
    );

    const [refreshed] = await pool.execute(
      'SELECT * FROM premium_status WHERE user_id = ? LIMIT 1',
      [req.userId],
    );
    res.json({
      success: true,
      data: { ...rowToStatus(refreshed[0] || null), trialStarted: true },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Pricing source of truth for the paywall.
 *
 * Returns the user-facing monthly / yearly prices for the current user. Today
 * the base prices are hardcoded here; once RevenueCat is wired in, swap this
 * out for an SDK call. The user's streak reward (`user_streak_counters.
 * discount_active` + `discount_percent`) is automatically applied to the
 * discounted price so the paywall can show "-25%" without any client logic.
 */
async function getPricing(req, res, next) {
  try {
    const [counters] = await pool.execute(
      `SELECT discount_active, discount_percent
         FROM user_streak_counters
        WHERE user_id = ?
        LIMIT 1`,
      [req.userId],
    );
    const row = counters[0] || {};
    const discountActive = Boolean(row.discount_active);
    const discountPct = Math.max(
      0,
      Math.min(80, Number.parseInt(row.discount_percent, 10) || 0),
    );

    // Per `docs/HomiFit – Premium Paket Özellikleri.docx`:
    // Aylık 1.99 USD, Yıllık 11.99 USD, 1 günlük deneme süresi.
    const baseMonthly = 1.99;
    const baseYearly = 11.99;
    const trialDays = 1;

    const monthly = discountActive
      ? Math.round(baseMonthly * (100 - discountPct)) / 100
      : baseMonthly;
    const yearly = discountActive
      ? Math.round(baseYearly * (100 - discountPct)) / 100
      : baseYearly;

    res.json({
      success: true,
      data: {
        currency: 'USD',
        currencySymbol: '$',
        trialDays,
        discountActive,
        discountPercent: discountPct,
        baseMonthly,
        baseYearly,
        monthly,
        yearly,
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const ACTIVE_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'TRIAL_STARTED',
  'TRIAL_CONVERTED',
  'UNCANCELLATION',
  'NON_RENEWING_PURCHASE',
]);

const INACTIVE_EVENTS = new Set([
  'CANCELLATION',
  'EXPIRATION',
  'BILLING_ISSUE',
  'SUBSCRIPTION_PAUSED',
  'REFUND',
]);

async function findUserId({ appUserId, email }) {
  if (appUserId) {
    // RevenueCat appUserId is typically the firebase uid (we use it that way).
    const [rows] = await pool.execute(
      'SELECT id FROM users WHERE firebase_uid = ? LIMIT 1',
      [appUserId],
    );
    if (rows.length > 0) return rows[0].id;
  }
  if (email) {
    const [rows] = await pool.execute(
      'SELECT id FROM users WHERE email = ? LIMIT 1',
      [email],
    );
    if (rows.length > 0) return rows[0].id;
  }
  return null;
}

async function revenueCatWebhook(req, res, next) {
  try {
    // Verify shared-secret header.
    const expected = process.env.REVENUECAT_WEBHOOK_SECRET || '';
    if (expected) {
      const auth = String(req.headers.authorization || '');
      const provided = auth.startsWith('Bearer ')
        ? auth.slice(7).trim()
        : auth.trim();
      if (!timingSafeEqual(provided, expected)) {
        throw new AppError('Invalid webhook signature', 401);
      }
    }

    const payload = req.body || {};
    const event = payload.event || {};
    const eventId = String(event.id || `${event.type}-${event.event_timestamp_ms}-${Math.random()}`);
    const eventType = String(event.type || 'UNKNOWN').toUpperCase();
    const appUserId = event.app_user_id || event.original_app_user_id || null;

    // Idempotency: skip if we've already stored this event_id.
    try {
      await pool.execute(
        `INSERT INTO premium_events (event_id, event_type, app_user_id, payload)
         VALUES (?, ?, ?, ?)`,
        [eventId, eventType, appUserId, JSON.stringify(payload)],
      );
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        return res.json({ success: true, data: { duplicate: true }, error: null });
      }
      throw err;
    }

    const userId = await findUserId({ appUserId, email: event.subscriber_attributes?.['$email']?.value });
    if (!userId) {
      // Stash with NULL user_id; humans / a reconciliation job can fix later.
      return res.json({ success: true, data: { stashed: true }, error: null });
    }

    const now = Date.now();
    const periodEndMs = event.expiration_at_ms ? Number(event.expiration_at_ms) : null;
    const isActive = ACTIVE_EVENTS.has(eventType)
      ? (periodEndMs ? periodEndMs > now : true)
      : (INACTIVE_EVENTS.has(eventType) ? false : null);

    const fields = ['user_id'];
    const placeholders = ['?'];
    const values = [userId];

    function set(field, value) {
      fields.push(field);
      placeholders.push('?');
      values.push(value);
    }

    if (isActive !== null) set('is_premium', isActive ? 1 : 0);
    if (event.entitlement_id) set('entitlement', event.entitlement_id);
    if (event.product_id) set('product_id', event.product_id);
    if (event.store) {
      const map = {
        APP_STORE: 'app_store',
        PLAY_STORE: 'play_store',
        STRIPE: 'stripe',
        AMAZON: 'manual',
        PROMOTIONAL: 'manual',
      };
      set('store', map[event.store] || 'manual');
    }
    if (event.transaction_id || event.purchased_at_ms) {
      set('purchase_token', event.transaction_id || null);
    }
    if (appUserId) set('original_app_user_id', appUserId);
    if (event.purchased_at_ms) {
      set('current_period_start', new Date(Number(event.purchased_at_ms)));
    }
    if (periodEndMs) set('current_period_end', new Date(periodEndMs));
    if (event.trial_end_at_ms) set('trial_end', new Date(Number(event.trial_end_at_ms)));
    if (eventType === 'CANCELLATION') set('cancelled_at', new Date());
    if (eventType === 'REFUND') set('refunded_at', new Date());

    const updateClauses = fields
      .filter((f) => f !== 'user_id')
      .map((f) => `${f} = VALUES(${f})`);

    await pool.execute(
      `INSERT INTO premium_status (${fields.join(', ')})
       VALUES (${placeholders.join(', ')})
       ${updateClauses.length > 0 ? 'ON DUPLICATE KEY UPDATE ' + updateClauses.join(', ') : ''}`,
      values,
    );

    await pool.execute(
      'UPDATE premium_events SET processed = 1, user_id = ? WHERE event_id = ?',
      [userId, eventId],
    );

    res.json({ success: true, data: { processed: true, userId }, error: null });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getStatus,
  getPricing,
  startTrial,
  revenueCatWebhook,
};
