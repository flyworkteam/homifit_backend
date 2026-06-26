const bunny = require('../config/bunnyCdn');

const FOCUS_AREA_SLUGS = new Set([
  'arms', 'shoulders', 'chest', 'back', 'core', 'legs', 'glutes', 'full_body',
]);

function buildVideoUrl(cdnPath) {
  if (!cdnPath) return null;
  try {
    return bunny.buildPullUrl(cdnPath);
  } catch (_) {
    return null;
  }
}

// Derive `exercise-thumbs/<clean-slug>.jpg` from a video CDN path when
// thumbnail_path is null (e.g. junk "-720" duplicate rows). Strip the
// resolution suffix so the clean filename is used.
const RESOLUTION_SUFFIX_RE = /-(?:144|240|360|480|540|720|1080|1440|2160)$/;
function deriveThumbnailPath(videoCdnPath) {
  if (!videoCdnPath) return null;
  const file = String(videoCdnPath).split('/').filter(Boolean).pop();
  if (!file) return null;
  let base = file.replace(/\.[^.]+$/, '');
  base = base.replace(RESOLUTION_SUFFIX_RE, '');
  return base ? `exercise-thumbs/${base}.jpg` : null;
}

function spreadDays(n) {
  switch (n) {
    case 1: return [0];
    case 2: return [0, 3];
    case 3: return [0, 2, 4];
    case 4: return [0, 1, 3, 4];
    case 5: return [0, 1, 2, 3, 4];
    case 6: return [0, 1, 2, 3, 4, 5];
    case 7: return [0, 1, 2, 3, 4, 5, 6];
    default: return Array.from({ length: Math.min(Math.max(n, 1), 7) }, (_, i) => i);
  }
}

function clampDaysPerWeek(n) {
  const v = Number.parseInt(n, 10);
  if (!Number.isFinite(v)) return 3;
  return Math.max(3, Math.min(6, v));
}

/**
 * Recommend a weekly training frequency from the user's onboarding answers.
 *
 * The onboarding flow never asks "how many days" — it always seeds 3, which is
 * why every generated plan landed on the fixed Mon/Wed/Fri week. When a goal +
 * level are known we derive the count from them so the schedule reflects the
 * user's actual answers; otherwise (e.g. the AI builder, where the user picks a
 * count themselves) we honor the requested [fallback].
 */
function recommendDaysPerWeek({ goal, level, fallback = 3 } = {}) {
  if (!goal && !level) return clampDaysPerWeek(fallback);

  let days;
  switch (level) {
    case 'advanced': days = 5; break;
    case 'intermediate': days = 4; break;
    case 'beginner': days = 3; break;
    default: days = fallback || 3;
  }
  switch (goal) {
    case 'lose_weight': days += 1; break; // higher frequency supports a deficit
    case 'boost_energy': days += 1; break; // frequent, lighter sessions
    case 'build_muscle': break; // strength gains need recovery between sessions
    case 'stay_fit': break;
    default: break;
  }
  return clampDaysPerWeek(days);
}

// ── Day title from the day's exercises ──────────────────────────────────────
//
// Each generated day is named after the muscle groups it actually trains so the
// plan reads like "Legs", "Chest & Back", "Core" instead of every day being a
// generic "Full Body". Labels are emitted in canonical English; the Flutter
// client re-localizes them via its focus-token table (localizedPlanDayTitle).
const FOCUS_LABELS = {
  full_body: 'Full Body',
  arms: 'Arms',
  shoulders: 'Shoulders',
  chest: 'Chest',
  back: 'Back',
  core: 'Core',
  legs: 'Legs',
  glutes: 'Glutes',
  cardio: 'Cardio',
};

function muscleToFocus(primaryMuscle) {
  const m = String(primaryMuscle || '').toLowerCase();
  if (!m) return 'full_body';
  if (m.includes('chest') || m.includes('pec')) return 'chest';
  if (m.includes('lat') || m.includes('back') || m.includes('trap') || m.includes('rhom')) return 'back';
  if (m.includes('shoulder') || m.includes('delt')) return 'shoulders';
  if (m.includes('bicep') || m.includes('tricep') || m.includes('forearm') || m.includes('arm')) return 'arms';
  if (m.includes('glute')) return 'glutes';
  if (
    m.includes('quad') || m.includes('hamstring') || m.includes('calf')
    || m.includes('calves') || m.includes('adductor') || m.includes('abductor')
    || m.includes('leg')
  ) return 'legs';
  if (m.includes('core') || m.includes('abdom') || m.includes('oblique') || m === 'abs') return 'core';
  if (m.includes('cardio') || m.includes('full')) return 'cardio';
  return 'full_body';
}

/**
 * Build a human day title from the muscle distribution of its exercises:
 *   - one dominant group            → that group ("Legs")
 *   - two clear groups              → "A & B" ("Chest & Back")
 *   - three or more, evenly spread  → "Full Body"
 */
function deriveDayTitle(exercises) {
  const counts = new Map();
  for (const e of exercises || []) {
    const focus = muscleToFocus(e.primaryMuscle);
    if (focus === 'full_body') continue; // unknown / generic — ignore for naming
    counts.set(focus, (counts.get(focus) || 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return FOCUS_LABELS.full_body;

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 1) return FOCUS_LABELS[sorted[0][0]];

  const [topFocus, topCount] = sorted[0];
  const [secondFocus, secondCount] = sorted[1];
  // Three+ groups that are fairly even → it's a full-body day.
  if (sorted.length >= 3 && (topCount + secondCount) / total < 0.7) {
    return FOCUS_LABELS.full_body;
  }
  return `${FOCUS_LABELS[topFocus]} & ${FOCUS_LABELS[secondFocus]}`;
}

function muscleMatchesFocus(focusSlug, primaryMuscle) {
  if (!primaryMuscle) return focusSlug === 'full_body';
  const pm = String(primaryMuscle).toLowerCase();
  const f = String(focusSlug).toLowerCase();
  if (pm === f) return true;
  if (f === 'shoulders' && pm.includes('shoulder')) return true;
  if (f === 'back' && (pm.includes('back') || pm.includes('shoulder'))) return true;
  if (f === 'glutes' && pm.includes('glute')) return true;
  if (f === 'legs' && (pm.includes('leg') || pm.includes('glute'))) return true;
  if (f === 'full_body') return true;
  return pm.includes(f);
}

function rowToCatalogExercise(row, locale) {
  const isTr = String(locale || '').toLowerCase().startsWith('tr');
  const unit = row.unit === 'seconds' ? 'seconds' : 'reps';
  return {
    slug: row.slug,
    name: (isTr && row.name_tr) ? row.name_tr : row.name_en,
    primaryMuscle: row.primary_muscle,
    unit,
    defaultSets: row.default_sets ?? 3,
    defaultValue: row.default_value ?? (unit === 'seconds' ? 30 : 12),
    thumbnailUrl:
      buildVideoUrl(row.thumbnail_path) ||
      buildVideoUrl(deriveThumbnailPath(row.video_cdn_path)),
    videoUrl: row.video_url || buildVideoUrl(row.video_cdn_path),
  };
}

function exerciseRowPayload(e, overrides = {}) {
  const unit = e.unit === 'seconds' ? 'seconds' : 'reps';
  const sets = clampInt(overrides.sets ?? e.defaultSets ?? 3, 1, 10);
  const value = clampInt(
    overrides.holdSeconds ?? overrides.reps ?? e.defaultValue ?? (unit === 'seconds' ? 30 : 12),
    1,
    unit === 'seconds' ? 900 : 200,
  );
  return {
    slug: e.slug,
    name: e.name,
    sets,
    ...(unit === 'seconds'
      ? { holdSeconds: value }
      : { reps: value }),
    restSeconds: clampInt(overrides.restSeconds ?? 30, 0, 600),
    thumbnailUrl: e.thumbnailUrl,
    primaryMuscle: e.primaryMuscle,
    unit,
  };
}

function clampInt(n, min, max) {
  const v = Number.parseInt(n, 10);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

/**
 * Load active catalog exercises that have a demo video.
 *
 * Exercises whose slug ends with a video-resolution suffix (e.g. "-720") are
 * duplicate/junk rows imported directly from raw video filenames. They have no
 * thumbnail, ugly names like "Bodyweight Squat 720", and are superseded by the
 * clean counterpart row (e.g. "bodyweight-squat"). Exclude them so the plan
 * generator always picks the canonical, fully-populated exercise records.
 */
async function loadCatalogExercises(pool, locale) {
  const [rows] = await pool.execute(
    `SELECT * FROM exercises
      WHERE active = 1
        AND slug NOT REGEXP '-(144|240|360|480|540|720|1080|1440|2160)$'
        AND (
          (video_url IS NOT NULL AND video_url != '')
          OR (video_cdn_path IS NOT NULL AND video_cdn_path != '')
        )
      ORDER BY primary_muscle, name_en`,
  );
  return rows
    .map((r) => rowToCatalogExercise(r, locale))
    .filter((e) => e.videoUrl);
}

function buildPoolsByFocus(catalog, focusAreas) {
  const muscles = focusAreas.length > 0 ? focusAreas : ['full_body'];
  const pools = {};
  for (const m of muscles) {
    pools[m] = catalog.filter((e) => muscleMatchesFocus(m, e.primaryMuscle));
  }
  return { muscles, pools };
}

/**
 * Deterministic catalog picker — mirrors the Flutter client fallback.
 */
function buildCatalogPlanDays({
  catalog,
  durationMin = 25,
  daysPerWeek = 3,
  focusAreas = [],
}) {
  const { muscles, pools } = buildPoolsByFocus(catalog, focusAreas);
  if (Object.values(pools).every((p) => p.length === 0)) {
    throw new Error('exercise catalog empty');
  }

  const weekdays = spreadDays(daysPerWeek);
  const perDay = Math.max(3, Math.min(8, Math.round(durationMin / 4)));
  const out = [];

  for (let d = 0; d < weekdays.length; d++) {
    const primary = pools[muscles[d % muscles.length]] || [];
    const picks = [];
    const used = new Set();
    const usedNames = new Set();

    function take(e) {
      const name = String(e.name || '').trim().toLowerCase();
      if (!usedNames.add(name)) return false;
      if (!used.add(e.slug)) return false;
      picks.push(e);
      return true;
    }

    let idx = Math.floor(d / muscles.length) * perDay;
    let scanned = 0;
    while (picks.length < perDay && scanned < primary.length) {
      take(primary[idx % primary.length]);
      idx += 1;
      scanned += 1;
    }
    for (const m of muscles) {
      if (picks.length >= perDay) break;
      for (const e of pools[m] || []) {
        if (picks.length >= perDay) break;
        take(e);
      }
    }

    out.push({
      weekday: weekdays[d],
      title: deriveDayTitle(picks),
      exercises: picks.map((e) => exerciseRowPayload(e)),
    });
  }
  return out;
}

/**
 * Merge AI-selected slugs/sets with catalog metadata.
 */
function enrichAiDays(aiDays, catalog, { durationMin, daysPerWeek, focusAreas }) {
  const bySlug = new Map(catalog.map((e) => [e.slug, e]));
  const weekdays = spreadDays(daysPerWeek);
  const perDay = Math.max(3, Math.min(8, Math.round(durationMin / 4)));
  const fallback = buildCatalogPlanDays({
    catalog, durationMin, daysPerWeek, focusAreas,
  });

  return weekdays.map((weekday, dIdx) => {
    const aiDay = Array.isArray(aiDays)
      ? aiDays.find((day) => Number(day.weekday) === weekday) || aiDays[dIdx]
      : null;
    const aiExercises = Array.isArray(aiDay?.exercises) ? aiDay.exercises : [];
    const used = new Set();
    const exercises = [];

    for (const raw of aiExercises) {
      if (exercises.length >= perDay) break;
      const slug = String(raw?.slug || '').trim();
      const cat = bySlug.get(slug);
      if (!cat || used.has(slug)) continue;
      used.add(slug);
      const unit = cat.unit;
      exercises.push(exerciseRowPayload(cat, {
        sets: raw.sets,
        reps: unit === 'reps' ? raw.reps : null,
        holdSeconds: unit === 'seconds' ? (raw.holdSeconds ?? raw.hold) : null,
        restSeconds: raw.restSeconds,
      }));
    }

    if (exercises.length === 0) {
      return fallback[dIdx] || { weekday, title: deriveDayTitle([]), exercises: [] };
    }

    const fb = fallback[dIdx]?.exercises || [];
    for (const e of fb) {
      if (exercises.length >= perDay) break;
      if (used.has(e.slug)) continue;
      used.add(e.slug);
      exercises.push(e);
    }

    return { weekday, title: deriveDayTitle(exercises), exercises };
  });
}

module.exports = {
  FOCUS_AREA_SLUGS,
  spreadDays,
  recommendDaysPerWeek,
  loadCatalogExercises,
  buildCatalogPlanDays,
  enrichAiDays,
  exerciseRowPayload,
};
