#!/usr/bin/env node
/**
 * Rewrite the per-template exercise prescription (`workout_template_exercises`
 * sets / reps / hold_seconds) from each exercise's own defaults so a template's
 * moves stop all reading the uniform seed value (3 sets × 12 reps).
 *
 * Run AFTER `backfillExerciseDefaults.js` (which fills exercises.unit /
 * default_value / default_sets).
 *
 * SAFE / NON-DESTRUCTIVE:
 *   - Only rewrites rows that still hold the generic seed signature
 *     (sets=3 AND reps=12 AND hold_seconds IS NULL). Any row that was curated
 *     to something else is left untouched.
 *   - Never deletes rows.
 *
 * Usage:
 *   node scripts/backfillTemplateExercisePrescription.js          # apply
 *   node scripts/backfillTemplateExercisePrescription.js --dry    # preview
 */

require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const DRY_RUN = process.argv.includes('--dry');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number.parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const [rows] = await conn.execute(
    `SELECT wte.id, wte.sets, wte.reps, wte.hold_seconds,
            e.unit, e.default_value, e.default_sets, e.slug
       FROM workout_template_exercises wte
       JOIN exercises e ON e.id = wte.exercise_id`,
  );

  let updated = 0;
  let skipped = 0;
  const samples = [];

  try {
    for (const row of rows) {
      const isGenericSeed =
        Number(row.sets) === 3 && Number(row.reps) === 12 && row.hold_seconds == null;
      if (!isGenericSeed) {
        skipped += 1;
        continue;
      }

      const sets = row.default_sets ?? 3;
      let reps = null;
      let holdSeconds = null;
      if (row.unit === 'seconds') {
        holdSeconds = row.default_value ?? 30;
      } else {
        reps = row.default_value ?? 12;
      }

      if (samples.length < 15) {
        samples.push(
          `${row.slug}: sets=${sets} ${holdSeconds != null ? `hold=${holdSeconds}s` : `reps=${reps}`}`,
        );
      }

      if (!DRY_RUN) {
        await conn.execute(
          `UPDATE workout_template_exercises
              SET sets = ?, reps = ?, hold_seconds = ?
            WHERE id = ?`,
          [sets, reps, holdSeconds, row.id],
        );
      }
      updated += 1;
    }

    console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}template-exercise rows scanned: ${rows.length}`);
    console.log(`  updated (generic seed): ${updated}`);
    console.log(`  skipped (curated)     : ${skipped}`);
    console.log('  samples:');
    for (const s of samples) console.log(`    - ${s}`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
