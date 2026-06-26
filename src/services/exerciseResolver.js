const { pool } = require('../config/db');
const catalog = require('./videoCatalog');

// Duplicate exercise rows with a resolution suffix in their slug (e.g.
// "bodyweight-squat-720") are junk — they have null thumbnails and ugly names.
// Always prefer the canonical clean-slug row when resolving for plan saves.
const RESOLUTION_SUFFIX = /-(?:144|240|360|480|540|720|1080|1440|2160)$/;
function cleanSlug(s) { return String(s || '').replace(RESOLUTION_SUFFIX, ''); }

/**
 * Resolve a (slug, name) pair to an exercise row id, auto-inserting a
 * minimal row if it doesn't exist yet. Looks up the BunnyCDN video URL
 * from the manifest by the same slug.
 *
 * Pass an existing DB connection (mid-transaction) to keep writes in the
 * same atomic scope as the calling code.
 *
 * @param {object} args
 * @param {string} args.slug   slugified exercise key (e.g. "bodyweight-squat")
 * @param {string} args.name   user-facing name (English fallback)
 * @param {string} [args.unit] 'reps' | 'seconds'
 * @param {string} [args.primaryMuscle]
 * @param {object} args.conn   mysql2 connection (or pool — execute() compatible)
 */
async function resolveOrCreate({ slug, name, unit = 'reps', primaryMuscle = null, conn }) {
  if (!slug) throw new Error('exercise slug is required');
  const db = conn || pool;

  // Strip resolution suffix so junk "-720" slugs resolve to the canonical row.
  const resolvedSlug = cleanSlug(slug);

  const [existing] = await db.execute(
    'SELECT id FROM exercises WHERE slug = ? LIMIT 1',
    [resolvedSlug],
  );
  if (existing.length > 0) {
    return existing[0].id;
  }

  // Also check original slug in case only it exists (no clean counterpart yet).
  if (resolvedSlug !== slug) {
    const [origExisting] = await db.execute(
      'SELECT id FROM exercises WHERE slug = ? LIMIT 1',
      [slug],
    );
    if (origExisting.length > 0) {
      return origExisting[0].id;
    }
  }

  // Look up video URL from the manifest if available.
  let videoCdnPath = null;
  let videoUrl = null;
  try {
    const c = catalog.loadCatalog();
    const hit = c.byBaseSlug[slug];
    if (hit) {
      const url = Array.isArray(hit) ? hit[0] : hit;
      videoUrl = url;
      // Reverse-derive the cdn path (after the host prefix).
      try {
        const parsed = new URL(url);
        videoCdnPath = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
      } catch (_) {
        videoCdnPath = null;
      }
    }
  } catch (_) {
    /* manifest may not be loaded — that's OK */
  }

  const [insert] = await db.execute(
    `INSERT INTO exercises (slug, name_en, primary_muscle, unit, video_cdn_path, video_url, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [resolvedSlug, name || resolvedSlug, primaryMuscle, unit === 'seconds' ? 'seconds' : 'reps', videoCdnPath, videoUrl],
  );
  return insert.insertId;
}

module.exports = {
  resolveOrCreate,
};
