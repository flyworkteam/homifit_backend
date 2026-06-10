#!/usr/bin/env node
/**
 * Give every workout_template a DISTINCT thumbnail_path so the home cards
 * (Popular Plans / Quick Workouts) never show the same image twice.
 *
 * Today all 36 templates have thumbnail_path = NULL, so the API borrows a
 * "representative exercise" poster via `list[tid % list.length]`
 * (workoutController.loadTemplatePreviews). That collides whenever templates
 * share moves — 7 collision groups in prod (e.g. gogus / gogus-ve-kol /
 * erkek-memelerinden all show diamond-push-up.jpg).
 *
 * Fix: greedily assign each template a poster from its OWN exercises, skipping
 * posters already taken by another template. Templates with the fewest
 * exercises are assigned first (least flexibility → first pick). The poster is
 * always thematically relevant (it's one of the template's own moves) and now
 * guaranteed unique. rowToTemplate() already prefers thumbnail_path over the
 * borrowed pick, so this takes effect immediately with no code change.
 *
 * Also repairs a few title_tr values that were title-cased from the slug and
 * lost their Turkish diacritics (cosmetic — the app localizes titles via the
 * frontend l10n `localizedTemplateTitle`, but the data should still be clean).
 *
 * Usage:
 *   node scripts/assignTemplateThumbnails.js            # dry-run (no writes)
 *   node scripts/assignTemplateThumbnails.js --apply     # write to the DB
 */
const fs = require('node:fs');
const path = require('node:path');
(function loadDotEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
})();

// Proper Turkish for the handful of title_tr values that were slug-title-cased.
const TITLE_FIXES = {
  'gogus-ve-kol-antrenmani': 'Göğüs ve Kol Antrenmanı',
  'karin-ve-core-guclendirme': 'Karın ve Core Güçlendirme',
  'omuz-ve-sirt-antrenmani': 'Omuz ve Sırt Antrenmanı',
  'baklava-karin-kasi-egzersizi': 'Baklava Karın Kası Egzersizi',
};

async function main() {
  const apply = process.argv.includes('--apply');
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, connectTimeout: 15000,
  });
  try {
    const [tpls] = await conn.query(
      'SELECT id, slug, category, title_tr, thumbnail_path FROM workout_templates ORDER BY id',
    );
    // Load each template's exercise posters in display order.
    const exByTpl = new Map();
    for (const t of tpls) {
      const [ex] = await conn.query(
        `SELECT e.slug, e.thumbnail_path
           FROM workout_template_exercises wte
           JOIN exercises e ON e.id = wte.exercise_id
          WHERE wte.template_id = ? AND e.thumbnail_path IS NOT NULL
          ORDER BY wte.position, wte.id`,
        [t.id],
      );
      exByTpl.set(t.id, ex);
    }

    // Greedy distinct assignment — most-constrained (fewest posters) first.
    const order = [...tpls].sort(
      (a, b) => (exByTpl.get(a.id).length - exByTpl.get(b.id).length) || a.id - b.id,
    );
    const used = new Set();
    const assignment = new Map();
    for (const t of order) {
      const cands = exByTpl.get(t.id);
      if (!cands.length) { assignment.set(t.id, null); continue; }
      let pick = cands.find((e) => !used.has(e.thumbnail_path));
      if (!pick) pick = cands[t.id % cands.length]; // all taken → fall back, still its own move
      used.add(pick.thumbnail_path);
      assignment.set(t.id, pick);
    }

    // Report
    const distinct = new Set([...assignment.values()].filter(Boolean).map((p) => p.thumbnail_path));
    console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}  |  templates: ${tpls.length}  |  distinct thumbnails: ${distinct.size}`);
    let titleFixCount = 0;
    for (const t of tpls) {
      const pick = assignment.get(t.id);
      const newTitle = TITLE_FIXES[t.slug];
      if (newTitle && newTitle !== t.title_tr) titleFixCount++;
      console.log(
        `  ${String(t.id).padStart(2)} ${t.slug.padEnd(34)} thumb→ ${(pick ? pick.thumbnail_path.split('/').pop() : 'NONE').padEnd(28)}` +
        (newTitle && newTitle !== t.title_tr ? `  title_tr: "${t.title_tr}" → "${newTitle}"` : ''),
      );
    }
    const noThumb = [...assignment.values()].filter((p) => !p).length;
    if (noThumb) console.log(`  ⚠ ${noThumb} template(s) have no exercise poster to use (left NULL).`);
    console.log(`  title_tr fixes: ${titleFixCount}`);

    if (!apply) { console.log('\nDRY-RUN: no changes written. Re-run with --apply to persist.'); return; }

    let wrote = 0;
    for (const t of tpls) {
      const pick = assignment.get(t.id);
      const newTitle = TITLE_FIXES[t.slug];
      const sets = [];
      const args = [];
      if (pick) { sets.push('thumbnail_path = ?'); args.push(pick.thumbnail_path); }
      if (newTitle && newTitle !== t.title_tr) { sets.push('title_tr = ?'); args.push(newTitle); }
      if (!sets.length) continue;
      args.push(t.id);
      const [r] = await conn.execute(`UPDATE workout_templates SET ${sets.join(', ')} WHERE id = ?`, args);
      wrote += r.affectedRows;
    }
    console.log(`\nAPPLIED: ${wrote} template row(s) updated.`);
  } finally {
    await conn.end();
  }
}
main().catch((e) => { console.error('ERR', e.code || '', e.message); process.exit(1); });
