const supportedLanguageCodes = new Set([
  'de',
  'en',
  'es',
  'fr',
  'hi',
  'it',
  'ja',
  'ko',
  'pt',
  'ru',
  'tr',
  'zh',
]);

function normalizeLanguageCode(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const primaryCode = normalized.split(',')[0].split('-')[0].trim();
  if (!supportedLanguageCodes.has(primaryCode)) {
    return null;
  }

  return primaryCode;
}

function resolveRequestLanguage(headers) {
  if (!headers || typeof headers !== 'object') {
    return 'en';
  }

  return (
    normalizeLanguageCode(headers['x-app-language'])
    || normalizeLanguageCode(headers['accept-language'])
    || 'en'
  );
}

module.exports = {
  normalizeLanguageCode,
  resolveRequestLanguage,
  supportedLanguageCodes,
};
