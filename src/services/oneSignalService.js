/**
 * Thin wrapper around the OneSignal REST API. The Flutter app already
 * registers each device's playerId via `onesignal_flutter`, so the backend
 * only needs to send notifications.
 *
 * Env: ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY.
 */

const ONESIGNAL_ENDPOINT = 'https://onesignal.com/api/v1/notifications';

function isConfigured() {
  return Boolean(
    process.env.ONESIGNAL_APP_ID && process.env.ONESIGNAL_REST_API_KEY,
  );
}

async function sendToPlayerIds(playerIds, { title, body, data = {} }) {
  if (!isConfigured()) {
    throw new Error('OneSignal credentials are not configured');
  }
  if (!Array.isArray(playerIds) || playerIds.length === 0) {
    throw new Error('playerIds must be a non-empty array');
  }

  const payload = {
    app_id: process.env.ONESIGNAL_APP_ID,
    include_player_ids: playerIds,
    headings: { en: title },
    contents: { en: body },
    data,
  };

  const res = await fetch(ONESIGNAL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Basic ${process.env.ONESIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`OneSignal request failed (${res.status})`);
    err.status = res.status;
    err.response = parsed;
    throw err;
  }
  return parsed;
}

async function broadcast({ title, body, data = {} }) {
  if (!isConfigured()) {
    throw new Error('OneSignal credentials are not configured');
  }
  const payload = {
    app_id: process.env.ONESIGNAL_APP_ID,
    included_segments: ['Subscribed Users'],
    headings: { en: title },
    contents: { en: body },
    data,
  };

  const res = await fetch(ONESIGNAL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Basic ${process.env.ONESIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`OneSignal broadcast failed (${res.status})`);
    err.status = res.status;
    err.response = parsed;
    throw err;
  }
  return parsed;
}

module.exports = {
  isConfigured,
  sendToPlayerIds,
  broadcast,
};
