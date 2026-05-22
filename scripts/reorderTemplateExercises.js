/**
 * Re-order exercises inside each workout_template to match the canonical
 * sequence in `docs/HomiFit Eğzersizler.docx`.
 *
 * Earlier seeds inserted exercises in alphabetical order — the workout
 * document was authored with a specific ordering (warm-up first, peak
 * intensity in the middle, cool-down last). This script wipes the
 * existing template_exercises rows for each known template and re-inserts
 * them at positions 1..N in the document order.
 *
 * Sets / reps / hold / rest are preserved from the existing row when
 * available; otherwise sensible defaults (3 sets × 12 reps OR 30s hold,
 * 30s rest) are used.
 */

require('dotenv').config();
const { pool } = require('../src/config/db');

// slug → ordered list of exercise slugs (exactly as in HomiFit Eğzersizler.docx)
const TEMPLATE_EXERCISES = {
  // ── Egzersizler (focus×level grid) ──────────────────────────────────────
  'tum-vucut': [
    'jumping-jack', 'burpee', 'squat-to-press', 'mountain-climber',
    'high-knees', 'skater-jump', 'squat-knee-raise', 'plank-walkout',
    'lunge-twist', 'inchworm',
  ],
  'karin-kaslari': [
    'crunch', 'bicycle-crunch', 'reverse-crunch', 'toe-touch-crunch',
    'heel-touch', 'leg-raise', 'flutter-kick', 'russian-twist', 'plank',
    'mountain-climber',
  ],
  'gogus': [
    'push-up', 'knee-push-up', 'wide-push-up', 'diamond-push-up',
    'incline-push-up', 'decline-bench-press', 'archer-push-up',
    'slow-push-up', 'explosive-push-up', 'plank-push-up',
  ],
  'kol': [
    'triceps-dip', 'close-grip-push-up', 'diamond-push-up', 'pike-push-up',
    'arm-circles', 'plank-shoulder-tap', 'bear-crawl-hold', 'plank-up-down',
    'wall-push-up', 'triceps-extension',
  ],
  'omuz-sirt': [
    'superman-back-extension', 'reverse-snow-angel', 'pike-push-up',
    'wall-walk', 'plank-shoulder-tap', 't-raise-floor', 'y-raise',
    'back-extension', 'arm-circles', 'reverse-plank',
  ],
  'bacak': [
    'bodyweight-squat', 'sumo-squat', 'jump-squat', 'forward-lunge',
    'reverse-lunge', 'side-lunge', 'wall-sit', 'glute-bridge',
    'bulgarian-split-squat-sandalye', 'calf-raise',
  ],

  // ── Warmup ────────────────────────────────────────────────────────────
  'isinma-hareketleri': [
    'neck-rotation', 'arm-circles', 'torso-twist', 'hip-circles',
    'leg-swings', 'bodyweight-squat-slow', 'high-knees-light',
    'jumping-jack-slow-tempo',
  ],

  // ── Popüler Antrenmanlar ─────────────────────────────────────────────
  'gobek-eriten-hiit': [
    'mountain-climber', 'high-knees', 'jump-squat', 'plank-jack',
    'skater-jump', 'bicycle-crunch', 'burpee', 'russian-twist',
  ],
  'erkek-memelerinden-kurtulma': [
    'push-up', 'wide-push-up', 'incline-push-up', 'diamond-push-up',
    'plank-shoulder-tap', 'jumping-jack', 'burpee', 'slow-push-up',
  ],
  'bel-agrisindan-kurtulma': [
    'cat-cow-stretch', 'child-pose', 'pelvic-tilt', 'bird-dog',
    'glute-bridge', 'superman-back-extension', 'knee-to-chest-stretch',
    'spinal-twist',
  ],
  '20-dakikada-tam-vucut-antremani': [
    'jumping-jack', 'bodyweight-squat', 'push-up', 'reverse-lunge',
    'mountain-climber', 'plank', 'skater-jump', 'inchworm',
  ],
  'tum-vucut-esneme-hareketleri': [
    'standing-forward-bend', 'cat-cow-stretch', 'cobra-stretch',
    'child-pose', 'hip-flexor-stretch', 'hamstring-stretch',
    'quad-stretch', 'spinal-twist',
  ],
  'ucgen-sirt-egzersizi': [
    'superman-back-extension', 'reverse-snow-angel', 't-raise-floor',
    'y-raise', 'pike-push-up', 'reverse-plank', 'plank-shoulder-tap',
    'back-extension',
  ],
  'sabah-isinmasi': [
    'neck-rotation', 'arm-circles', 'torso-twist', 'hip-circles',
    'leg-swings', 'bodyweight-squat', 'high-knees-light',
    'jumping-jack-slow-tempo',
  ],
  'baklava-karin-kasi-egzersizi': [
    'crunch', 'bicycle-crunch', 'reverse-crunch', 'toe-touch-crunch',
    'leg-raise', 'flutter-kick', 'russian-twist', 'plank',
  ],
  'tum-vucut-yag-yakma': [
    'burpee', 'jump-squat', 'mountain-climber', 'high-knees',
    'skater-jump', 'squat-knee-raise', 'jumping-jack', 'plank-walkout',
  ],
  'evde-dambil-egzersizi': [
    'dumbbell-squat', 'dumbbell-goblet-squat', 'dumbbell-lunges',
    'dumbbell-romanian-deadlift', 'dumbbell-chest-press',
    'dumbbell-shoulder-press', 'dumbbell-lateral-raise',
    'dumbbell-bent-over-row', 'dumbbell-biceps-curl',
    'dumbbell-triceps-overhead-extension',
  ],
  'gerinme': [
    'neck-stretch', 'shoulder-stretch', 'triceps-stretch',
    'standing-forward-bend', 'cat-cow-stretch', 'cobra-stretch',
    'child-pose', 'hamstring-stretch', 'quad-stretch', 'spinal-twist',
  ],

  // ── Trend Planlar ─────────────────────────────────────────────────────
  'yogun-karin-yagi-yakimi': [
    'mountain-climber', 'high-knees', 'burpee', 'jump-squat', 'plank-jack',
    'bicycle-crunch', 'russian-twist', 'flutter-kick', 'toe-touch-crunch',
    'skater-jump',
  ],
  'kalistenik-plani': [
    'push-up', 'pull-up', 'bodyweight-squat', 'lunges',
    'dips-bench-or-paralel-bar', 'plank', 'pike-push-up', 'inchworm',
    'superman-back-extension', 'wall-sit',
  ],
  'kilo-verme-plani': [
    'jumping-jack', 'squat', 'reverse-lunge', 'mountain-climber',
    'high-knees', 'skater-jump', 'burpee', 'plank-walkout',
    'squat-knee-raise', 'fast-feet-shuffle',
  ],

  // ── Hızlı Egzersizler ────────────────────────────────────────────────
  'hizli-egzersizler': [
    'jumping-jack', 'bodyweight-squat', 'push-up', 'mountain-climber',
    'reverse-lunge', 'plank', 'high-knees', 'burpee',
  ],

  // ── Günlük Antrenmanlar ──────────────────────────────────────────────
  'tum-vucut-baslangic-antrenmani': [
    'jumping-jack', 'bodyweight-squat', 'push-up', 'reverse-lunge',
    'mountain-climber', 'plank', 'high-knees',
  ],
  'karin-ve-core-guclendirme': [
    'crunch', 'bicycle-crunch', 'reverse-crunch', 'leg-raise',
    'russian-twist', 'flutter-kick', 'plank',
  ],
  'bacak-ve-kalca-guclendirme': [
    'bodyweight-squat', 'sumo-squat', 'reverse-lunge', 'side-lunge',
    'glute-bridge', 'wall-sit', 'calf-raise',
  ],
  'gogus-ve-kol-antrenmani': [
    'push-up', 'wide-push-up', 'diamond-push-up', 'incline-push-up',
    'triceps-dip', 'pike-push-up', 'plank-shoulder-tap',
  ],
  'omuz-ve-sirt-antrenmani': [
    'superman-back-extension', 'reverse-snow-angel', 'pike-push-up',
    'back-extension', 't-raise-floor', 'y-raise', 'reverse-plank',
  ],

  // ── Genel Antrenmanlar ───────────────────────────────────────────────
  'hizli-tum-vucut-antrenmani': [
    'jumping-jack', 'bodyweight-squat', 'push-up', 'mountain-climber',
    'reverse-lunge', 'plank', 'high-knees',
  ],
  'evde-yag-yakma-antrenmani': [
    'burpee', 'jump-squat', 'mountain-climber', 'skater-jump',
    'high-knees', 'plank-jack', 'jumping-jack',
  ],
  'evde-guc-antrenmani': [
    'push-up', 'bodyweight-squat', 'reverse-lunge', 'pike-push-up',
    'glute-bridge', 'superman-back-extension', 'plank',
  ],
  'core-ve-karin-antrenmani': [
    'crunch', 'bicycle-crunch', 'leg-raise', 'russian-twist',
    'flutter-kick', 'heel-touch', 'plank',
  ],
  'alt-vucut-antrenmani': [
    'bodyweight-squat', 'sumo-squat', 'reverse-lunge', 'side-lunge',
    'glute-bridge', 'wall-sit', 'calf-raise',
  ],
  'ust-vucut-antrenmani': [
    'push-up', 'wide-push-up', 'diamond-push-up', 'pike-push-up',
    'triceps-dip', 'superman-back-extension', 'plank-shoulder-tap',
  ],
  'hiit-kardiyo-antrenmani': [
    'burpee', 'high-knees', 'jump-squat', 'mountain-climber',
    'skater-jump', 'jumping-jack', 'fast-feet-shuffle',
  ],
  'karin-kasi-antrenmani-egzersizleri': [
    'crunch', 'bicycle-crunch', 'reverse-crunch', 'leg-raise',
    'flutter-kick', 'russian-twist', 'plank',
  ],
};

// Sensible per-exercise defaults when the existing row didn't carry data.
function defaultsForExercise(unit) {
  if (unit === 'seconds') {
    return { sets: 3, reps: null, holdSeconds: 30, restSeconds: 30 };
  }
  return { sets: 3, reps: 12, holdSeconds: null, restSeconds: 30 };
}

(async () => {
  const conn = await pool.getConnection();
  let okT = 0, okE = 0, missT = 0, missE = 0;
  const missingExercises = new Set();
  try {
    for (const [templateSlug, exerciseSlugs] of Object.entries(TEMPLATE_EXERCISES)) {
      const [tplRows] = await conn.execute(
        'SELECT id FROM workout_templates WHERE slug = ? LIMIT 1',
        [templateSlug],
      );
      if (tplRows.length === 0) {
        console.log('  ⚠ template missing:', templateSlug);
        missT++;
        continue;
      }
      const templateId = tplRows[0].id;

      // Pull existing (template_id, exercise_id) → defaults so we can
      // preserve sets/reps/rest if they were customized previously.
      const [existing] = await conn.execute(
        'SELECT exercise_id, sets, reps, hold_seconds, rest_seconds FROM workout_template_exercises WHERE template_id = ?',
        [templateId],
      );
      const existingById = new Map(existing.map((r) => [Number(r.exercise_id), r]));

      // Resolve every exercise slug → id (and unit for defaults).
      const resolved = [];
      for (const slug of exerciseSlugs) {
        const [ex] = await conn.execute(
          'SELECT id, unit FROM exercises WHERE slug = ? LIMIT 1',
          [slug],
        );
        if (ex.length === 0) {
          missingExercises.add(slug);
          missE++;
          continue;
        }
        resolved.push({ id: ex[0].id, unit: ex[0].unit });
      }

      // Wipe + re-insert with the canonical positions.
      await conn.beginTransaction();
      try {
        await conn.execute(
          'DELETE FROM workout_template_exercises WHERE template_id = ?',
          [templateId],
        );
        for (let i = 0; i < resolved.length; i++) {
          const { id: exId, unit } = resolved[i];
          const prev = existingById.get(Number(exId));
          const defs = defaultsForExercise(unit);
          const sets = prev?.sets ?? defs.sets;
          const reps = prev?.reps ?? defs.reps;
          const hold = prev?.hold_seconds ?? defs.holdSeconds;
          const rest = prev?.rest_seconds ?? defs.restSeconds;
          await conn.execute(
            'INSERT INTO workout_template_exercises (template_id, exercise_id, position, sets, reps, hold_seconds, rest_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [templateId, exId, i + 1, sets, reps, hold, rest],
          );
          okE++;
        }
        await conn.commit();
        okT++;
        console.log(`  ✓ ${templateSlug} (${resolved.length} exercises)`);
      } catch (e) {
        await conn.rollback();
        console.log(`  ✗ ${templateSlug}: ${e.message}`);
      }
    }
  } finally {
    conn.release();
  }

  console.log('');
  console.log(`done: templates ok=${okT} missing=${missT} | exercises ok=${okE} missing=${missE}`);
  if (missingExercises.size) {
    console.log('missing exercise slugs:', Array.from(missingExercises).join(', '));
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
