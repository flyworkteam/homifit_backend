#!/usr/bin/env node
/**
 * Seed the `exercises` table from BunnyCDN's video-manifest.json.
 *
 * Each unique base slug becomes one row. The first manifest entry for a slug
 * provides the canonical video URL; alternative URLs (same exercise in
 * multiple categories) are ignored — the planner can re-target later.
 *
 * Idempotent: existing rows are updated (video_url + name kept fresh),
 * new rows are inserted, no row is deleted.
 *
 *   node scripts/seedExercisesFromManifest.js [--manifest path]
 */

require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

// Map common Turkish folder names to a primary muscle slug.
const MUSCLE_BY_FOLDER = {
  'kol': 'arms',
  'kollar': 'arms',
  'omuz': 'shoulders',
  'omuzlar': 'shoulders',
  'gogus': 'chest',
  'sirt': 'back',
  'omuz-sirt': 'shoulders_back', // combined CDN folder (app's 6-group taxonomy)
  'karin': 'core',
  'karin-kaslari': 'core',
  'bacak': 'legs',
  'bacaklar': 'legs',
  'kalca': 'glutes',
  'tum-vucut': 'full_body',
};
// NOTE: the canonical muscle folders (bacak/gogus/karin-kaslari/kol/omuz-sirt/
// tum-vucut) are also backfilled by migration 010 — keep the two in sync so a
// re-seed never reverts the Stats screen muscle breakdown.

// Slug → readable English name fallback.
function prettify(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function deriveMuscle(cdnPath) {
  // egzersizler/<muscle>/<file>.mp4
  const segs = cdnPath.split('/');
  if (segs.length < 3) return null;
  if (segs[0] === 'egzersizler') {
    return MUSCLE_BY_FOLDER[segs[1]] || null;
  }
  // genel-antremanlar/alt-vucut-antrenmani/.. → null (mixed)
  return null;
}

function deriveUnit(name) {
  if (/plank|hold|wall sit|wall-sit/i.test(name)) return 'seconds';
  return 'reps';
}

async function main() {
  const manifestPath =
    process.argv.includes('--manifest')
      ? process.argv[process.argv.indexOf('--manifest') + 1]
      : path.resolve(__dirname, '..', 'config', 'video-manifest.json');

  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const seen = new Map(); // baseSlug → { cdnPath, url, muscle }
  for (const v of manifest.videos || []) {
    const ext = path.extname(v.cdnPath);
    const base = path.basename(v.cdnPath, ext);
    if (!seen.has(base)) {
      seen.set(base, {
        cdnPath: v.cdnPath,
        url: v.url,
        muscle: deriveMuscle(v.cdnPath),
        source: v.source,
      });
    }
  }

  console.log(`Manifest: ${manifest.videos?.length || 0} videos → ${seen.size} unique slugs`);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number.parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  let inserted = 0;
  let updated = 0;
  try {
    for (const [slug, data] of seen) {
      const name = prettify(slug);
      const unit = deriveUnit(name);
      const muscle = data.muscle;

      const [existing] = await conn.execute(
        'SELECT id FROM exercises WHERE slug = ? LIMIT 1',
        [slug],
      );
      if (existing.length > 0) {
        await conn.execute(
          `UPDATE exercises
              SET video_cdn_path = ?, video_url = ?,
                  primary_muscle = COALESCE(primary_muscle, ?),
                  unit = COALESCE(unit, ?),
                  active = 1
            WHERE id = ?`,
          [data.cdnPath, data.url, muscle, unit, existing[0].id],
        );
        updated += 1;
      } else {
        await conn.execute(
          `INSERT INTO exercises
             (slug, name_en, primary_muscle, unit, video_cdn_path, video_url, active)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
          [slug, name, muscle, unit, data.cdnPath, data.url],
        );
        inserted += 1;
      }
    }

    const [count] = await conn.execute('SELECT COUNT(*) AS n FROM exercises');
    console.log(`✓ inserted=${inserted} updated=${updated}; total exercises now: ${count[0].n}`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
