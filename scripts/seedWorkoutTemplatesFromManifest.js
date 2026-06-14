#!/usr/bin/env node
/**
 * Seed `workout_templates` + `workout_template_exercises` from the BunnyCDN
 * video manifest. Each second-level folder in the manifest (e.g.
 * `populer-antremanlar/20-dakikada-tam-vucut-antremani/<exercise>.mp4`)
 * becomes one workout template; every video inside becomes a positioned
 * exercise on that template.
 *
 * Idempotent: existing templates are updated, new ones inserted, untouched
 * exercises preserved. Workout_template_exercises rows for the affected
 * templates are fully rebuilt on each run so order changes propagate.
 */

require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const MANIFEST_PATH = path.resolve(__dirname, '..', 'config', 'video-manifest.json');

// Top-level CDN folder → grouping for the app.
const CATEGORY_BY_TOP = {
  'populer-antremanlar': 'popular',
  'trend-planlar': 'trending',
  'gunluk-antremanlar': 'daily',
  'genel-antremanlar': 'general',
  'hizli-egzersizler': 'quick',
  'isinma-hareketleri': 'warmup',
  'karin-kasi-antrenmani-egzersizleri': 'core_abs',
};

// Per-template category overrides. Their CDN folder lives under populer/gunluk/
// genel-antremanlar, but they are ab/core workouts and belong in the
// "Core & Abs" (core_abs) section per the design — otherwise that section only
// has 2 cards. Keep in sync with
// migrations/sql/009_recategorize_core_abs_templates.sql.
const CATEGORY_OVERRIDE = {
  'baklava-karin-kasi-egzersizi': 'core_abs',
  'karin-ve-core-guclendirme': 'core_abs',
  'core-ve-karin-antrenmani': 'core_abs',
};

// Map slug → user-facing Turkish title (uses canonical names from the design).
const TITLE_TR = {
  // Popüler
  'gobek-eriten-hiit': 'Göbek Eriten HIIT',
  'kadin-memelerinden-kurtulma': 'Kadın Memelerinden Kurtulma',
  'bel-agrisindan-kurtulma': 'Bel Ağrısından Kurtulma',
  '20-dakikada-tam-vucut-antremani': '20 Dakikada Tam Vücut',
  'tum-vucut-esneme-hareketleri': 'Tüm Vücut Esneme',
  'ucgen-sirt-egzersizi': 'Üçgen Sırt Egzersizi',
  'sabah-isinmasi': 'Sabah Isınması',
  'baklava-karin-kasi-egzersizleri': 'Baklava Karın Kası',
  'tum-vucut-yag-yakma': 'Tüm Vücut Yağ Yakma',
  'evde-dambil-egzersizi': 'Evde Dambıl Egzersizi',
  // Trend
  'evde-yag-yakma-antrenmani': 'Evde Yağ Yakma',
  'hizli-tum-vucut-antrenmani': 'Hızlı Tüm Vücut',
  'core-ve-karin-antrenmani': 'Core & Karın',
  'evde-guc-antrenmani': 'Evde Güç Antrenmanı',
  'hiit-kardiyo-antrenmani': 'HIIT Kardiyo',
  'ust-vucut-antrenmani': 'Üst Vücut',
  'alt-vucut-antrenmani': 'Alt Vücut',
  'yogun-karin-yagi-yakimi': 'Yoğun Karın Yağı Yakımı',
  'kalistenik-plani': 'Kalistenik Planı',
  'kilo-verme-plani': 'Kilo Verme Planı',
  // Günlük
  'bacak-ve-kalca-guclendirme': 'Bacak & Kalça Güçlendirme',
  'tum-vucut-baslangic-antrenmani': 'Tüm Vücut Başlangıç',
  // Generic top-level (one-off categories)
  'hizli-egzersizler': 'Hızlı Egzersizler',
  'isinma-hareketleri': 'Isınma Hareketleri',
  'karin-kasi-antrenmani-egzersizleri': 'Karın Kası Antrenmanı',
};

const TITLE_EN = {
  'gobek-eriten-hiit': 'Belly Burning HIIT',
  'kadin-memelerinden-kurtulma': 'Reduce Chest Fat',
  'bel-agrisindan-kurtulma': 'Back Pain Relief',
  '20-dakikada-tam-vucut-antremani': '20-Minute Full Body',
  'tum-vucut-esneme-hareketleri': 'Full Body Stretch',
  'ucgen-sirt-egzersizi': 'Triangle Back',
  'sabah-isinmasi': 'Morning Warmup',
  'baklava-karin-kasi-egzersizleri': 'Abs Builder',
  'tum-vucut-yag-yakma': 'Full Body Fat Burn',
  'evde-dambil-egzersizi': 'Dumbbell at Home',
  'evde-yag-yakma-antrenmani': 'Fat Burn at Home',
  'hizli-tum-vucut-antrenmani': 'Quick Full Body',
  'core-ve-karin-antrenmani': 'Core & Abs',
  'evde-guc-antrenmani': 'Home Strength',
  'hiit-kardiyo-antrenmani': 'HIIT Cardio',
  'ust-vucut-antrenmani': 'Upper Body',
  'alt-vucut-antrenmani': 'Lower Body',
  'yogun-karin-yagi-yakimi': 'Intense Belly Fat Burn',
  'kalistenik-plani': 'Calisthenics Plan',
  'kilo-verme-plani': 'Weight Loss Plan',
  'bacak-ve-kalca-guclendirme': 'Leg & Glute Strength',
  'tum-vucut-baslangic-antrenmani': 'Full Body Beginner',
  'hizli-egzersizler': 'Quick Workouts',
  'isinma-hareketleri': 'Warmup Movements',
  'karin-kasi-antrenmani-egzersizleri': 'Ab Training',
};

function prettify(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function levelFor(slug) {
  if (slug.includes('baslangic') || slug.includes('beginner')) return 'beginner';
  if (slug.includes('ileri') || slug.includes('advanced') || slug.includes('yogun')) return 'advanced';
  return 'all';
}

function isPremiumFor(slug) {
  // First two from each category free; everything else premium-gated.
  // Tweak the gating rule as needed.
  return false;
}

async function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`Manifest not found: ${MANIFEST_PATH}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  // Group videos by (topFolder, subFolder).
  const groups = new Map(); // key="top/sub" → { top, sub, items[] }
  for (const v of manifest.videos || []) {
    const segs = v.cdnPath.split('/');
    if (segs.length < 2) continue;
    const top = segs[0];
    let sub;
    let file;
    if (segs.length === 2) {
      // Flat category (e.g. hizli-egzersizler/<file>.mp4) — treat the top
      // folder itself as the template.
      sub = top;
      file = segs[1];
    } else {
      sub = segs[1];
      file = segs[segs.length - 1];
    }
    const key = `${top}/${sub}`;
    if (!groups.has(key)) groups.set(key, { top, sub, items: [] });
    const ext = path.extname(file);
    const exerciseSlug = path.basename(file, ext);
    groups.get(key).items.push({ exerciseSlug, cdnPath: v.cdnPath, url: v.url });
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number.parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  // Pre-load exercise id lookup by slug.
  const [allEx] = await conn.execute('SELECT id, slug, name_en, name_tr FROM exercises');
  const exBySlug = new Map(allEx.map((r) => [r.slug, r]));

  let inserted = 0;
  let updated = 0;
  let totalLinked = 0;
  let sortOrder = 0;

  try {
    for (const [, group] of groups) {
      const { top, sub, items } = group;
      if (items.length === 0) continue;

      const slug = sub.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      const category =
        CATEGORY_OVERRIDE[slug] ||
        CATEGORY_BY_TOP[top] ||
        top.replace(/[^a-z0-9]+/g, '_');
      const titleTr = TITLE_TR[slug] || prettify(slug);
      const titleEn = TITLE_EN[slug] || prettify(slug);
      const level = levelFor(slug);
      const isPremium = isPremiumFor(slug) ? 1 : 0;
      // Average duration estimate from item count (3 min per exercise).
      const durationMin = Math.max(8, Math.min(45, items.length * 3));

      // Upsert template.
      const [existing] = await conn.execute(
        'SELECT id FROM workout_templates WHERE slug = ? LIMIT 1',
        [slug],
      );
      let templateId;
      if (existing.length > 0) {
        templateId = existing[0].id;
        await conn.execute(
          `UPDATE workout_templates
              SET category = ?, title_en = ?, title_tr = ?, level = ?,
                  duration_min = ?, is_premium = ?, active = 1, sort_order = ?
            WHERE id = ?`,
          [category, titleEn, titleTr, level, durationMin, isPremium, sortOrder++, templateId],
        );
        updated += 1;
      } else {
        const [ins] = await conn.execute(
          `INSERT INTO workout_templates
             (slug, category, title_en, title_tr, level, duration_min,
              is_premium, active, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          [slug, category, titleEn, titleTr, level, durationMin, isPremium, sortOrder++],
        );
        templateId = ins.insertId;
        inserted += 1;
      }

      // Wipe + rebuild template_exercises rows for ordering consistency.
      await conn.execute(
        'DELETE FROM workout_template_exercises WHERE template_id = ?',
        [templateId],
      );

      let position = 1;
      for (const it of items) {
        let exRow = exBySlug.get(it.exerciseSlug);
        if (!exRow) {
          // Auto-create the exercise from manifest if not yet seeded.
          const niceName = prettify(it.exerciseSlug);
          const [insEx] = await conn.execute(
            `INSERT INTO exercises (slug, name_en, video_cdn_path, video_url, active)
             VALUES (?, ?, ?, ?, 1)`,
            [it.exerciseSlug, niceName, it.cdnPath, it.url],
          );
          exRow = { id: insEx.insertId, slug: it.exerciseSlug, name_en: niceName, name_tr: null };
          exBySlug.set(it.exerciseSlug, exRow);
        }
        await conn.execute(
          `INSERT INTO workout_template_exercises
             (template_id, exercise_id, position, sets, reps, hold_seconds, rest_seconds)
           VALUES (?, ?, ?, 3, 12, NULL, 30)`,
          [templateId, exRow.id, position++],
        );
        totalLinked += 1;
      }
    }

    const [cnt] = await conn.execute('SELECT COUNT(*) AS n FROM workout_templates WHERE active = 1');
    console.log(
      `✓ inserted=${inserted} updated=${updated} totalLinked=${totalLinked}; active templates: ${cnt[0].n}`,
    );
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
