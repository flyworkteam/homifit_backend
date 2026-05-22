/**
 * BunnyCDN configuration. The storage zone holds exercise/workout videos and
 * the CDN pull zone serves them to clients.
 *
 * Env vars (see .env.example):
 *   BUNNY_PULL_HOSTNAME      — e.g. homifit.b-cdn.net
 *   BUNNY_STORAGE_ZONE       — storage zone / FTP username (e.g. homifit)
 *   BUNNY_STORAGE_PASSWORD   — access key (acts as FTP pwd + Storage API key)
 *   BUNNY_STORAGE_HOSTNAME   — storage host, default storage.bunnycdn.com
 */

const DEFAULT_STORAGE_HOSTNAME = 'storage.bunnycdn.com';

function readEnv() {
  return {
    pullHostname: String(process.env.BUNNY_PULL_HOSTNAME || '').trim(),
    storageZone: String(process.env.BUNNY_STORAGE_ZONE || '').trim(),
    storagePassword: String(process.env.BUNNY_STORAGE_PASSWORD || '').trim(),
    storageHostname:
      String(process.env.BUNNY_STORAGE_HOSTNAME || '').trim() ||
      DEFAULT_STORAGE_HOSTNAME,
  };
}

function isConfigured() {
  const cfg = readEnv();
  return Boolean(cfg.pullHostname && cfg.storageZone && cfg.storagePassword);
}

/**
 * Build a public pull-zone URL for a stored object.
 * @param {string} objectPath  e.g. "exercises/jumping-jacks.mp4"
 */
function buildPullUrl(objectPath) {
  const { pullHostname } = readEnv();
  if (!pullHostname) {
    throw new Error('BUNNY_PULL_HOSTNAME is not configured');
  }
  const cleanPath = String(objectPath || '').replace(/^\/+/, '');
  return `https://${pullHostname}/${cleanPath}`;
}

/**
 * Build the Storage API base URL for the configured zone.
 */
function buildStorageApiUrl(objectPath = '') {
  const { storageHostname, storageZone } = readEnv();
  const cleanPath = String(objectPath || '').replace(/^\/+/, '');
  return `https://${storageHostname}/${storageZone}/${cleanPath}`;
}

function getConfig() {
  return readEnv();
}

module.exports = {
  isConfigured,
  buildPullUrl,
  buildStorageApiUrl,
  getConfig,
};
