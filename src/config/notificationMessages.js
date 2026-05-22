/**
 * Bildirim metinleri ve gönderim politikası.
 * Kaynak: docs/HomiFit – Bildirim Seçenekleri.docx
 *
 * - Mesajlar 6 saatte bir gönderilir.
 * - Aynı metin art arda kullanılmaz; dönüşümlü olarak gösterilir.
 */

const FREQUENCY_HOURS = 6;
const FREQUENCY_MINUTES = FREQUENCY_HOURS * 60;
const FREQUENCY_MS = FREQUENCY_HOURS * 60 * 60 * 1000;

/**
 * Şu anlık locale tek (tr). İleride i18n eklemek istersen anahtarı koru,
 * yeni dil array'i ekle.
 */
const MESSAGES = {
  tr: [
    {
      id: 'tr-1',
      title: 'HomiFit',
      body: 'Bugünün antrenmanı seni bekliyor. Başlamaya ne dersin.',
    },
    {
      id: 'tr-2',
      title: 'HomiFit',
      body: 'Evde kısa bir egzersiz molası iyi gelebilir.',
    },
    {
      id: 'tr-3',
      title: 'HomiFit',
      body: 'Bugünkü antrenmanını tamamlamayı unutma.',
    },
    {
      id: 'tr-4',
      title: 'HomiFit',
      body: 'Programında yeni bir egzersiz seni bekliyor.',
    },
    {
      id: 'tr-5',
      title: 'HomiFit',
      body: 'Fitness hedefin için bugün bir adım daha atabilirsin.',
    },
    {
      id: 'tr-6',
      title: 'HomiFit',
      body: 'HomiFit\'te bugünün egzersizini başlatabilirsin.',
    },
  ],
  en: [
    {
      id: 'en-1',
      title: 'HomiFit',
      body: 'Today\'s workout is waiting. Ready to start?',
    },
    {
      id: 'en-2',
      title: 'HomiFit',
      body: 'A quick exercise break at home could feel great.',
    },
    {
      id: 'en-3',
      title: 'HomiFit',
      body: 'Don\'t forget to finish today\'s workout.',
    },
    {
      id: 'en-4',
      title: 'HomiFit',
      body: 'A new exercise is waiting in your program.',
    },
    {
      id: 'en-5',
      title: 'HomiFit',
      body: 'Take one more step toward your fitness goal today.',
    },
    {
      id: 'en-6',
      title: 'HomiFit',
      body: 'Start today\'s workout in HomiFit.',
    },
  ],
};

const SUPPORTED_LOCALES = Object.keys(MESSAGES);
const DEFAULT_LOCALE = 'tr';

function listMessages(locale) {
  const key = SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  return MESSAGES[key].map((m) => ({ ...m, locale: key }));
}

function getById(id) {
  for (const list of Object.values(MESSAGES)) {
    const hit = list.find((m) => m.id === id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Sıradaki bildirimi seç. lastSentId verilirse aynı metin tekrar
 * kullanılmaz (dönüşümlü davranış).
 *
 * @param {string} locale       Tercih edilen dil (tr/en)
 * @param {string|null} lastId  Bir önceki gönderimde kullanılan id
 * @returns {{title:string, body:string, id:string, locale:string}}
 */
function pickNextMessage(locale, lastId = null) {
  const list = listMessages(locale);
  if (list.length === 0) return null;
  let candidates = list;
  if (lastId) {
    const filtered = list.filter((m) => m.id !== lastId);
    if (filtered.length > 0) candidates = filtered;
  }
  const choice = candidates[Math.floor(Math.random() * candidates.length)];
  return choice;
}

module.exports = {
  FREQUENCY_HOURS,
  FREQUENCY_MINUTES,
  FREQUENCY_MS,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  listMessages,
  getById,
  pickNextMessage,
};
