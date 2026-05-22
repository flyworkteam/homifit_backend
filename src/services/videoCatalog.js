const fs = require('node:fs');
const path = require('node:path');
const bunny = require('../config/bunnyCdn');

const TURKISH_MAP = {
  'ı': 'i', 'I': 'I', 'İ': 'I',
  'ğ': 'g', 'Ğ': 'G',
  'ş': 's', 'Ş': 'S',
  'ö': 'o', 'Ö': 'O',
  'ü': 'u', 'Ü': 'U',
  'ç': 'c', 'Ç': 'C',
};

function slugify(value) {
  let out = '';
  for (const ch of String(value || '')) {
    out += TURKISH_MAP[ch] !== undefined ? TURKISH_MAP[ch] : ch;
  }
  return out
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

let _cache = null;
let _cacheMtimeMs = 0;

function manifestPath() {
  return (
    process.env.VIDEO_MANIFEST_PATH ||
    path.resolve(__dirname, '..', '..', 'config', 'video-manifest.json')
  );
}

/**
 * Load the manifest produced by `scripts/uploadCdnVideos.js`. Cached and
 * refreshed automatically when the file's mtime changes.
 */
function loadCatalog() {
  const file = manifestPath();
  if (!fs.existsSync(file)) {
    return { videos: [], byBaseSlug: {}, byCategory: {}, generatedAt: null };
  }
  const stat = fs.statSync(file);
  if (_cache && _cacheMtimeMs === stat.mtimeMs) {
    return _cache;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Group by top-level CDN folder for "category" lookups.
  const byCategory = {};
  for (const v of raw.videos || []) {
    const top = String(v.cdnPath || '').split('/')[0];
    if (!top) continue;
    (byCategory[top] = byCategory[top] || []).push(v);
  }

  _cache = {
    generatedAt: raw.generatedAt || null,
    pullHostname: raw.pullHostname || bunny.getConfig().pullHostname,
    videos: raw.videos || [],
    byBaseSlug: raw.byBaseSlug || {},
    byCategory,
  };
  _cacheMtimeMs = stat.mtimeMs;
  return _cache;
}

/**
 * Resolve a CDN URL by exercise name. Looks up the slugified base name
 * (e.g. "Bodyweight Squat" → "bodyweight-squat"). Returns null if not found.
 * If the slug is ambiguous (multiple sources produced the same base name),
 * the first registered URL is returned.
 */
function findUrlByName(name) {
  const slug = slugify(name);
  if (!slug) return null;
  const c = loadCatalog();
  const hit = c.byBaseSlug[slug];
  if (!hit) return null;
  return Array.isArray(hit) ? hit[0] : hit;
}

/**
 * Return all CDN URLs for a slug (covers ambiguous lookups where the same
 * exercise name lives under several categories).
 */
function findAllUrlsByName(name) {
  const slug = slugify(name);
  if (!slug) return [];
  const c = loadCatalog();
  const hit = c.byBaseSlug[slug];
  if (!hit) return [];
  return Array.isArray(hit) ? hit.slice() : [hit];
}

function listCategories() {
  const c = loadCatalog();
  return Object.keys(c.byCategory).map((slug) => ({
    slug,
    count: c.byCategory[slug].length,
  }));
}

function listByCategory(slug) {
  const c = loadCatalog();
  const list = c.byCategory[slug] || [];
  return list.map((v) => ({
    name: path.basename(v.cdnPath, path.extname(v.cdnPath)),
    cdnPath: v.cdnPath,
    url: v.url,
    source: v.source,
  }));
}

function listAll() {
  return loadCatalog().videos.slice();
}

module.exports = {
  slugify,
  loadCatalog,
  findUrlByName,
  findAllUrlsByName,
  listCategories,
  listByCategory,
  listAll,
  manifestPath,
};
