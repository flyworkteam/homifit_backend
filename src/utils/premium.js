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
 *   - Everything else (paid subscriptions maintained by the RevenueCat
 *     webhook, which flips `is_premium` to 0 on EXPIRATION/CANCELLATION):
 *     honor `is_premium`, plus any still-live trial window as a safety net.
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
  return Boolean(r.is_premium) || trialActive;
}

module.exports = { isEffectivelyPremium };
