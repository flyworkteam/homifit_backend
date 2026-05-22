const { pool } = require('../config/db');
const catalog = require('./videoCatalog');

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

  const [existing] = await db.execute(
    'SELECT id FROM exercises WHERE slug = ? LIMIT 1',
    [slug],
  );
  if (existing.length > 0) {
    return existing[0].id;
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
    [slug, name || slug, primaryMuscle, unit === 'seconds' ? 'seconds' : 'reps', videoCdnPath, videoUrl],
  );
  return insert.insertId;
}

module.exports = {
  resolveOrCreate,
};
