#!/usr/bin/env node
/**
 * Clean up the handful of exercises whose name_tr kept English sentence
 * structure, so workout lists don't read as a Turkish/English mix.
 *
 * Convention (matches the product's own catalog docx and the rest of the
 * data): established loanwords stay (Squat, Plank, Burpee, Jumping Jack,
 * Dumbbell, Press, Deadlift, Dip, Twist) — only descriptive phrases are
 * Turkish ("Triceps Açma", "Yana Kaldırma", "Hamle + Twist").
 *
 * Usage:
 *   node scripts/fixExerciseTurkishNames.js          # dry-run
 *   node scripts/fixExerciseTurkishNames.js --apply  # write to the DB
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

const FIXES = {
  // "to" was English glue — the data's own pattern is "Squat + Diz Kaldırma".
  'squat-to-press': 'Squat + Press',
  // Half-translated ("Shuffle" left over).
  'fast-feet-shuffle': 'Hızlı Adımlama',
  // Mirrors "Dumbbell Triceps Açma".
  'dumbbell-biceps-curl': 'Dumbbell Biceps Kıvırma',
  // Drop the redundant English parenthetical.
  'mountain-climber': 'Dağcı',
  // "Bench" → "Bank".
  'dips-bench-or-paralel-bar': 'Dips (Bank / Paralel Bar)',
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
    const slugs = Object.keys(FIXES);
    const [rows] = await conn.query(
      'SELECT slug, name_tr FROM exercises WHERE slug IN (?)', [slugs],
    );
    console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
    let changed = 0;
    for (const r of rows) {
      const next = FIXES[r.slug];
      const same = r.name_tr === next;
      console.log(`  ${r.slug.padEnd(28)} "${r.name_tr}" -> "${next}"${same ? '  (zaten ayni)' : ''}`);
      if (!same) changed++;
    }
    const missing = slugs.filter((s) => !rows.some((r) => r.slug === s));
    if (missing.length) console.log('  ! bulunamayan slug:', missing.join(', '));
    if (!apply) { console.log(`\nDRY-RUN: ${changed} satir degisecek. --apply ile yaz.`); return; }
    let wrote = 0;
    for (const [slug, nameTr] of Object.entries(FIXES)) {
      const [r] = await conn.execute(
        'UPDATE exercises SET name_tr = ? WHERE slug = ? AND name_tr <> ?',
        [nameTr, slug, nameTr],
      );
      wrote += r.affectedRows;
    }
    console.log(`\nAPPLIED: ${wrote} satir guncellendi.`);
  } finally {
    await conn.end();
  }
}
main().catch((e) => { console.error('ERR', e.code || '', e.message); process.exit(1); });
