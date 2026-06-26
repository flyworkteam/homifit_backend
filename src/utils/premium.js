/**
 * Single source of truth for "is this user effectively premium right now?".
 *
 * Why this exists: the backend-managed free trial (`POST /premium/start-trial`)
 * sets `is_premium = 1` and `trial_end = NOW + 3 days`, but **nothing ever
 * resets `is_premium` to 0 when the trial expires** — a manual trial has no
 * RevenueCat subscription behind it, so no EXPIRATION webhook fires, and there
 * is no cron. So the `is_premium` column is sticky-1 forever for trial users,
 * and trusting it directly means the trial never ends.
 *
 * Rule:
 *   - Trial rows (`entitlement = 'trial'`): premium ONLY while the live trial
 *     window is open (`trial_end > NOW`). Never trust the sticky flag.
 *   - Paid subscriptions: honor `is_premium`, BUT if a billing period end is
 *     known (`current_period_end`) it must still be in the future. This guards
 *     against a missed/failed EXPIRATION webhook leaving `is_premium` stuck at
 *     1 forever — a lapsed paid user should lose access the moment their period
 *     ends, even if RevenueCat never told us. A NULL `current_period_end` means
 *     a non-expiring grant (lifetime / NON_RENEWING_PURCHASE) and is honored.
 *   - A still-live trial window always acts as a safety net on top.
 *
 * @param {object|null} r  A `premium_status` row (snake_case columns) or null.
 * @param {number} [nowMs] Current time in ms (injectable for tests).
 * @returns {boolean}
 */
function isEffectivelyPremium(r, nowMs = Date.now()) {
  if (!r) return false;
  const trialActive =
    r.trial_end != null && new Date(r.trial_end).getTime() > nowMs;
  if (r.entitlement === 'trial') return trialActive;

  // Paid/other rows: a known period end must not be in the past.
  const periodActive =
    r.current_period_end == null ||
    new Date(r.current_period_end).getTime() > nowMs;
  if (Boolean(r.is_premium) && periodActive) return true;
  return trialActive;
}

module.exports = { isEffectivelyPremium };
