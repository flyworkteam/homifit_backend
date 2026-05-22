/**
 * Bildirim rotation + zamanlama servisi.
 *
 * Politika (docs/HomiFit – Bildirim Seçenekleri.docx):
 *   - 6 saatte bir gönderim
 *   - Aynı metin art arda kullanılmaz, dönüşümlü
 *
 * Bu modül "memory" durumu in-process tutuyor. Production'da bunu DB tablosuna
 * (notification_log) taşımak gerekir; placeholder implementasyon dev için
 * çalışır.
 */

const messages = require('../config/notificationMessages');
const oneSignal = require('./oneSignalService');

// userId → { lastId, lastSentAt }
const _state = new Map();

function _getUserState(userId) {
  if (!_state.has(userId)) {
    _state.set(userId, { lastId: null, lastSentAt: null });
  }
  return _state.get(userId);
}

/**
 * Kullanıcı için sıradaki bildirimi seç (preview / debug). Gönderme yapmaz.
 */
function previewNext(userId, locale = 'tr') {
  const state = _getUserState(userId);
  const next = messages.pickNextMessage(locale, state.lastId);
  return {
    next,
    lastSentAt: state.lastSentAt,
    nextEligibleAt: state.lastSentAt
      ? new Date(state.lastSentAt + messages.FREQUENCY_MS).toISOString()
      : new Date().toISOString(),
  };
}

/**
 * Kullanıcının bir sonraki bildirimini almasının zamanı geldi mi.
 */
function isDue(userId) {
  const state = _getUserState(userId);
  if (!state.lastSentAt) return true;
  return Date.now() - state.lastSentAt >= messages.FREQUENCY_MS;
}

/**
 * Tek kullanıcıya bildirim gönder (rotation + cooldown gözeterek).
 *
 * @param {object} args
 * @param {number} args.userId
 * @param {string[]} args.playerIds   OneSignal device playerId(s)
 * @param {string}  [args.locale]
 * @param {boolean} [args.force]      Cooldown'u yok say
 * @returns {Promise<{sent:boolean, reason?:string, message?:object, response?:object}>}
 */
async function sendNext({ userId, playerIds, locale = 'tr', force = false }) {
  if (!Array.isArray(playerIds) || playerIds.length === 0) {
    return { sent: false, reason: 'no_player_ids' };
  }
  const state = _getUserState(userId);
  if (!force && !isDue(userId)) {
    return {
      sent: false,
      reason: 'cooldown',
      nextEligibleAt: new Date(
        state.lastSentAt + messages.FREQUENCY_MS,
      ).toISOString(),
    };
  }

  const message = messages.pickNextMessage(locale, state.lastId);
  if (!message) {
    return { sent: false, reason: 'no_messages' };
  }

  let response = null;
  if (oneSignal.isConfigured()) {
    response = await oneSignal.sendToPlayerIds(playerIds, {
      title: message.title,
      body: message.body,
      data: { messageId: message.id, source: 'rotation' },
    });
  }

  state.lastId = message.id;
  state.lastSentAt = Date.now();

  return { sent: true, message, response };
}

/**
 * Manuel reset (test/debug için).
 */
function resetUser(userId) {
  _state.delete(userId);
}

module.exports = {
  previewNext,
  isDue,
  sendNext,
  resetUser,
  FREQUENCY_HOURS: messages.FREQUENCY_HOURS,
  FREQUENCY_MS: messages.FREQUENCY_MS,
};
