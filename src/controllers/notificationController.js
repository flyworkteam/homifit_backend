const AppError = require('../utils/appError');
const { pool } = require('../config/db');
const messages = require('../config/notificationMessages');
const oneSignal = require('../services/oneSignalService');

const COOLDOWN_MS = messages.FREQUENCY_MS;

async function ensurePrefRow(userId, locale) {
  await pool.execute(
    `INSERT IGNORE INTO user_notification_prefs (user_id, locale)
     VALUES (?, ?)`,
    [userId, locale || 'tr'],
  );
}

async function loadPrefs(userId) {
  const [rows] = await pool.execute(
    'SELECT * FROM user_notification_prefs WHERE user_id = ? LIMIT 1',
    [userId],
  );
  return rows[0] || null;
}

async function loadState(userId) {
  const [rows] = await pool.execute(
    'SELECT * FROM user_notification_state WHERE user_id = ? LIMIT 1',
    [userId],
  );
  return rows[0] || null;
}

async function loadActivePlayerIds(userId) {
  const [rows] = await pool.execute(
    `SELECT player_id FROM device_tokens
      WHERE user_id = ? AND is_active = 1`,
    [userId],
  );
  return rows.map((r) => r.player_id);
}

async function getPreferences(req, res, next) {
  try {
    await ensurePrefRow(req.userId, req.locale);
    const prefs = await loadPrefs(req.userId);
    res.json({
      success: true,
      data: {
        enabled: Boolean(prefs.enabled),
        locale: prefs.locale,
        frequencyHours: prefs.frequency_hours,
        quietHoursStart: prefs.quiet_hours_start,
        quietHoursEnd: prefs.quiet_hours_end,
        workoutReminders: Boolean(prefs.workout_reminders),
        streakReminders: Boolean(prefs.streak_reminders),
        promoMessages: Boolean(prefs.promo_messages),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function updatePreferences(req, res, next) {
  try {
    await ensurePrefRow(req.userId, req.locale);
    const body = req.body || {};
    const patch = [];
    const params = [];

    function pushBool(field, key) {
      if (typeof body[key] === 'boolean') {
        patch.push(`${field} = ?`);
        params.push(body[key] ? 1 : 0);
      }
    }
    pushBool('enabled', 'enabled');
    pushBool('workout_reminders', 'workoutReminders');
    pushBool('streak_reminders', 'streakReminders');
    pushBool('promo_messages', 'promoMessages');

    if (typeof body.locale === 'string') {
      const locale = body.locale.toLowerCase();
      if (!messages.SUPPORTED_LOCALES.includes(locale)) {
        throw new AppError(`Unsupported locale: ${locale}`, 400);
      }
      patch.push('locale = ?');
      params.push(locale);
    }
    if (typeof body.frequencyHours === 'number') {
      const f = Math.max(1, Math.min(48, Math.trunc(body.frequencyHours)));
      patch.push('frequency_hours = ?');
      params.push(f);
    }
    if ('quietHoursStart' in body) {
      patch.push('quiet_hours_start = ?');
      params.push(body.quietHoursStart || null);
    }
    if ('quietHoursEnd' in body) {
      patch.push('quiet_hours_end = ?');
      params.push(body.quietHoursEnd || null);
    }

    if (patch.length > 0) {
      params.push(req.userId);
      await pool.execute(
        `UPDATE user_notification_prefs SET ${patch.join(', ')} WHERE user_id = ?`,
        params,
      );
    }

    return getPreferences(req, res, next);
  } catch (error) {
    next(error);
  }
}

async function listMessages(req, res, next) {
  try {
    const locale = String(
      req.query.locale || req.locale || messages.DEFAULT_LOCALE,
    ).toLowerCase();
    res.json({
      success: true,
      data: {
        locale,
        frequencyHours: messages.FREQUENCY_HOURS,
        messages: messages.listMessages(locale),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function previewNext(req, res, next) {
  try {
    await ensurePrefRow(req.userId, req.locale);
    const prefs = await loadPrefs(req.userId);
    const state = await loadState(req.userId);
    const next = messages.pickNextMessage(prefs.locale, state ? state.last_message_id : null);
    res.json({
      success: true,
      data: {
        next,
        lastSentAt: state ? state.last_sent_at : null,
        nextEligibleAt: state && state.last_sent_at
          ? new Date(new Date(state.last_sent_at).getTime() + COOLDOWN_MS).toISOString()
          : new Date().toISOString(),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function registerDevice(req, res, next) {
  try {
    const body = req.body || {};
    const playerId = String(body.playerId || '').trim();
    if (!playerId) throw new AppError('playerId is required', 400);
    const platform = String(body.platform || '').toLowerCase();
    if (!['ios', 'android', 'web'].includes(platform)) {
      throw new AppError('platform must be ios|android|web', 400);
    }

    await pool.execute(
      `INSERT INTO device_tokens
         (user_id, player_id, platform, app_version, device_model, locale, is_active, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE
         user_id      = VALUES(user_id),
         platform     = VALUES(platform),
         app_version  = VALUES(app_version),
         device_model = VALUES(device_model),
         locale       = VALUES(locale),
         is_active    = 1,
         last_seen_at = CURRENT_TIMESTAMP`,
      [
        req.userId,
        playerId,
        platform,
        body.appVersion ? String(body.appVersion).slice(0, 32) : null,
        body.deviceModel ? String(body.deviceModel).slice(0, 80) : null,
        body.locale ? String(body.locale).slice(0, 8) : null,
      ],
    );
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (error) {
    next(error);
  }
}

async function unregisterDevice(req, res, next) {
  try {
    const body = req.body || {};
    const playerId = String(body.playerId || '').trim();
    if (!playerId) throw new AppError('playerId is required', 400);
    await pool.execute(
      'UPDATE device_tokens SET is_active = 0 WHERE user_id = ? AND player_id = ?',
      [req.userId, playerId],
    );
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (error) {
    next(error);
  }
}

async function sendNow(req, res, next) {
  try {
    await ensurePrefRow(req.userId, req.locale);
    const prefs = await loadPrefs(req.userId);
    if (!prefs.enabled) {
      throw new AppError('Notifications are disabled for this user', 409);
    }

    const body = req.body || {};
    const force = Boolean(body.force);
    const state = await loadState(req.userId);
    if (!force && state && state.last_sent_at) {
      const wait = COOLDOWN_MS - (Date.now() - new Date(state.last_sent_at).getTime());
      if (wait > 0) {
        return res.json({
          success: true,
          data: {
            sent: false,
            reason: 'cooldown',
            nextEligibleAt: new Date(Date.now() + wait).toISOString(),
          },
          error: null,
        });
      }
    }

    let playerIds = Array.isArray(body.playerIds) ? body.playerIds.map(String) : null;
    if (!playerIds || playerIds.length === 0) {
      playerIds = await loadActivePlayerIds(req.userId);
    }
    if (playerIds.length === 0) {
      return res.json({
        success: true,
        data: { sent: false, reason: 'no_player_ids' },
        error: null,
      });
    }

    const message = messages.pickNextMessage(prefs.locale, state ? state.last_message_id : null);
    if (!message) {
      return res.json({
        success: true,
        data: { sent: false, reason: 'no_messages' },
        error: null,
      });
    }

    let providerResponse = null;
    let providerResponseId = null;
    if (oneSignal.isConfigured()) {
      providerResponse = await oneSignal.sendToPlayerIds(playerIds, {
        title: message.title,
        body: message.body,
        data: { messageId: message.id, source: 'rotation' },
      });
      providerResponseId = providerResponse?.id || null;
    }

    // Persist state + log.
    await pool.execute(
      `INSERT INTO user_notification_state
         (user_id, last_message_id, last_sent_at, next_eligible_at, consecutive_sends)
       VALUES (?, ?, CURRENT_TIMESTAMP, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? HOUR), 1)
       ON DUPLICATE KEY UPDATE
         last_message_id  = VALUES(last_message_id),
         last_sent_at     = VALUES(last_sent_at),
         next_eligible_at = VALUES(next_eligible_at),
         consecutive_sends = consecutive_sends + 1`,
      [req.userId, message.id, prefs.frequency_hours],
    );

    await pool.execute(
      `INSERT INTO notification_log
         (user_id, message_id, title, body, locale, channel, provider, provider_response_id)
       VALUES (?, ?, ?, ?, ?, 'push', ?, ?)`,
      [
        req.userId,
        message.id,
        message.title,
        message.body,
        prefs.locale,
        oneSignal.isConfigured() ? 'onesignal' : 'manual',
        providerResponseId,
      ],
    );

    res.json({
      success: true,
      data: { sent: true, message, providerResponseId },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function listInbox(req, res, next) {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    const [rows] = await pool.execute(
      `SELECT * FROM user_inbox
        WHERE user_id = ? AND archived_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?`,
      [req.userId, limit],
    );
    res.json({
      success: true,
      data: {
        inbox: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          title: r.title,
          body: r.body,
          ctaLabel: r.cta_label,
          ctaRoute: r.cta_route,
          read: Boolean(r.read_at),
          createdAt: r.created_at,
        })),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function markInboxRead(req, res, next) {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) throw new AppError('id must be integer', 400);
    await pool.execute(
      'UPDATE user_inbox SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE id = ? AND user_id = ?',
      [id, req.userId],
    );
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (error) {
    next(error);
  }
}

async function clearInbox(req, res, next) {
  try {
    await pool.execute(
      'UPDATE user_inbox SET archived_at = CURRENT_TIMESTAMP WHERE user_id = ? AND archived_at IS NULL',
      [req.userId],
    );
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getPreferences,
  updatePreferences,
  listMessages,
  previewNext,
  sendNow,
  registerDevice,
  unregisterDevice,
  listInbox,
  markInboxRead,
  clearInbox,
};
