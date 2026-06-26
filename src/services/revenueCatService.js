/**
 * Thin wrapper around the RevenueCat REST API (v1).
 *
 * Used by `POST /premium/sync` to pull the authoritative subscriber state right
 * after a purchase, so paid content unlocks immediately instead of waiting for
 * the asynchronous purchase webhook (which can lag a few seconds). The webhook
 * remains the long-term source of truth for renewals/expirations; this is the
 * instant-gratification path on top of it.
 *
 * Env: REVENUECAT_API_KEY  — a RevenueCat *secret* API key (starts with `sk_`).
 *      When unset every function degrades to a graceful no-op so the sync
 *      endpoint still works (it just falls back to whatever the webhook wrote).
 */

const REST_BASE = 'https://api.revenuecat.com/v1';
const REQUEST_TIMEOUT_MS = 8000;

function isConfigured() {
  return Boolean((process.env.REVENUECAT_API_KEY || '').trim());
}

/**
 * Fetch a subscriber object from RevenueCat by app user id (we use the
 * Firebase uid as the RC app user id — see the client `identifyBackendUser`).
 * Returns the `subscriber` object or null on any failure / when not configured.
 */
async function fetchSubscriber(appUserId) {
  const key = (process.env.REVENUECAT_API_KEY || '').trim();
  if (!key || !appUserId) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${REST_BASE}/subscribers/${encodeURIComponent(appUserId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json && json.subscriber ? json.subscriber : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const STORE_MAP = {
  app_store: 'app_store',
  mac_app_store: 'app_store',
  play_store: 'play_store',
  stripe: 'stripe',
  amazon: 'manual',
  promotional: 'manual',
};

/**
 * Reduce a RevenueCat subscriber object to the columns we persist in
 * `premium_status`. Premium is true when ANY entitlement is currently active
 * (expires in the future or never expires) — this mirrors the webhook, which
 * sets `is_premium` from the event rather than matching a specific entitlement
 * id, so it's robust to entitlement renames.
 *
 * @returns {{isPremium:boolean, entitlement?:string|null, productId?:string|null,
 *   store?:string|null, currentPeriodStart?:Date|null, currentPeriodEnd?:Date|null}|null}
 */
function deriveStatus(subscriber, nowMs = Date.now()) {
  if (!subscriber) return null;
  const entitlements = subscriber.entitlements || {};
  const subscriptions = subscriber.subscriptions || {};

  let chosen = null;
  for (const [id, ent] of Object.entries(entitlements)) {
    const expMs = ent && ent.expires_date ? Date.parse(ent.expires_date) : null;
    const active = expMs == null || (Number.isFinite(expMs) && expMs > nowMs);
    if (active) {
      chosen = { id, ...ent, _expMs: expMs };
      break;
    }
  }

  if (!chosen) return { isPremium: false };

  const productId = chosen.product_identifier || null;
  const sub = productId ? subscriptions[productId] : null;
  const store = sub && sub.store ? (STORE_MAP[sub.store] || 'manual') : null;
  const startMs = chosen.purchase_date ? Date.parse(chosen.purchase_date) : null;

  return {
    isPremium: true,
    entitlement: chosen.id,
    productId,
    store,
    currentPeriodStart: Number.isFinite(startMs) ? new Date(startMs) : null,
    currentPeriodEnd: chosen._expMs ? new Date(chosen._expMs) : null,
  };
}

module.exports = {
  isConfigured,
  fetchSubscriber,
  deriveStatus,
};
