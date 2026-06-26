#!/usr/bin/env node
/**
 * Backfill per-exercise prescription defaults on the `exercises` table so every
 * move has realistic, distinct sets / reps-or-hold / secondary muscles instead
 * of the uniform seed values (sets=3, reps=12) that made every exercise look
 * identical in the workout-detail screen and the Training Insights.
 *
 * Heuristic (no manual data entry):
 *   - unit         : 'seconds' for isometric/hold/stretch moves (plank, wall
 *                    sit, hollow hold, bridge hold, stretch…), else 'reps'.
 *   - default_value: holds → 25–45s by difficulty; reps → 10–15 by muscle.
 *   - default_sets : stretch/warmup → 2, core → 4, otherwise 3.
 *   - secondary_muscles : derived from the primary muscle group when empty.
 *
 * SAFE / NON-DESTRUCTIVE:
 *   - Only fills rows that look UN-CURATED (default_value IS NULL). Any row that
 *     already has a default_value is left untouched, so manual edits survive.
 *   - secondary_muscles is only written when currently NULL/empty.
 *   - Never deletes data.
 *
 * Usage:
 *   node scripts/backfillExerciseDefaults.js          # apply
 *   node scripts/backfillExerciseDefaults.js --dry    # preview only
 */

require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const DRY_RUN = process.argv.includes('--dry');

// Keywords (slug + EN/TR names, lowercased) that mark a timed / isometric move.
const HOLD_KEYWORDS = [
  'plank', 'hold', 'isometric', 'isometrik', 'wall-sit', 'wall sit', 'duvar',
  'hollow', 'superman', 'bridge', 'kopru', 'köprü', 'l-sit', 'lsit', 'dead-hang',
  'dead hang', 'hang', 'asili', 'asılı', 'balance', 'denge', 'durus', 'duruş',
  'static', 'statik', 'stretch', 'esneme', 'germe', 'side-plank', 'side plank',
  'yan-plank', 'bekle', 'tutus', 'tutuş', 'wall', 'hold-', 'sit-hold',
];

const STRETCH_KEYWORDS = [
  'stretch', 'esneme', 'germe', 'warmup', 'warm-up', 'isinma', 'ısınma',
  'mobility', 'mobilite', 'cooldown', 'cool-down',
];

// Primary focus → reasonable secondary (assisting) muscles. Chosen so the
// indirect volume / muscle-focus chart spans more than the single prime mover.
const SECONDARY_BY_FOCUS = {
  chest: ['triceps', 'shoulders'],
  back: ['biceps', 'shoulders'],
  shoulders: ['triceps'],
  arms: ['shoulders'],
  legs: ['glutes', 'core'],
  glutes: ['hamstrings', 'core'],
  core: ['shoulders'],
  full_body: ['core'],
  cardio: ['core'],
};

function focusOf(muscle) {
  const m = String(muscle || '').toLowerCase();
  if (!m) return 'full_body';
  if (m.includes('chest') || m.includes('pec')) return 'chest';
  if (m.includes('lat') || m.includes('back') || m.includes('trap') || m.includes('rhom')) return 'back';
  if (m.includes('shoulder') || m.includes('delt')) return 'shoulders';
  if (m.includes('bicep') || m.includes('tricep') || m.includes('forearm') || m.includes('arm')) return 'arms';
  if (m.includes('glute')) return 'glutes';
  if (
    m.includes('quad') || m.includes('hamstring') || m.includes('calf')
    || m.includes('calves') || m.includes('adductor') || m.includes('abductor') || m.includes('leg')
  ) return 'legs';
  if (m.includes('core') || m.includes('abdom') || m.includes('oblique') || m === 'abs') return 'core';
  if (m.includes('cardio') || m.includes('full')) return 'full_body';
  return 'full_body';
}

function matchesAny(haystack, keywords) {
  return keywords.some((k) => haystack.includes(k));
}

function deriveDefaults(row) {
  const hay = `${row.slug || ''} ${row.name_en || ''} ${row.name_tr || ''}`.toLowerCase();
  const focus = focusOf(row.primary_muscle);
  const isStretch = matchesAny(hay, STRETCH_KEYWORDS);
  const isHold = isStretch || matchesAny(hay, HOLD_KEYWORDS);
  const difficulty = String(row.difficulty || 'beginner');

  let unit;
  let defaultValue;
  if (isHold) {
    unit = 'seconds';
    defaultValue = difficulty === 'advanced' ? 45 : difficulty === 'intermediate' ? 40 : 30;
    if (isStretch) defaultValue = 30;
  } else {
    unit = 'reps';
    // Higher reps for endurance-y lower-body / core; classic 12 elsewhere; a
    // touch lower for advanced strength moves.
    if (focus === 'core' || focus === 'legs' || focus === 'glutes' || focus === 'full_body') {
      defaultValue = 15;
    } else {
      defaultValue = difficulty === 'advanced' ? 10 : 12;
    }
  }

  let defaultSets;
  if (isStretch) defaultSets = 2;
  else if (focus === 'core') defaultSets = 4;
  else defaultSets = 3;

  return { unit, defaultValue, defaultSets, focus };
}

function currentSecondary(raw) {
  if (raw == null) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number.parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const [rows] = await conn.execute(
    `SELECT id, slug, name_en, name_tr, primary_muscle, secondary_muscles,
            unit, default_value, default_sets, difficulty
       FROM exercises`,
  );

  let filledDefaults = 0;
  let filledSecondary = 0;
  let skipped = 0;
  const samples = [];

  try {
    for (const row of rows) {
      const { unit, defaultValue, defaultSets, focus } = deriveDefaults(row);

      // Only treat rows with NO default_value as un-curated (fill them). Rows
      // already carrying a value are respected and left alone.
      const needsDefaults = row.default_value == null;

      const sec = currentSecondary(row.secondary_muscles);
      const needsSecondary = sec.length === 0;
      const newSecondary = needsSecondary ? (SECONDARY_BY_FOCUS[focus] || []) : sec;

      if (!needsDefaults && !needsSecondary) {
        skipped += 1;
        continue;
      }

      const sets = [];
      const params = [];
      if (needsDefaults) {
        sets.push('unit = ?', 'default_value = ?', 'default_sets = ?');
        params.push(unit, defaultValue, defaultSets);
        filledDefaults += 1;
      }
      if (needsSecondary && newSecondary.length > 0) {
        sets.push('secondary_muscles = ?');
        params.push(JSON.stringify(newSecondary));
        filledSecondary += 1;
      }
      if (sets.length === 0) {
        skipped += 1;
        continue;
      }

      if (samples.length < 15) {
        samples.push(
          `${row.slug}: unit=${unit} value=${defaultValue} sets=${defaultSets} sec=[${newSecondary.join(',')}]`,
        );
      }

      if (!DRY_RUN) {
        params.push(row.id);
        await conn.execute(`UPDATE exercises SET ${sets.join(', ')} WHERE id = ?`, params);
      }
    }

    console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}exercises scanned: ${rows.length}`);
    console.log(`  defaults filled : ${filledDefaults}`);
    console.log(`  secondary filled: ${filledSecondary}`);
    console.log(`  skipped (curated): ${skipped}`);
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
