const AppError = require('../utils/appError');
const { pool } = require('../config/db');
const bunny = require('../config/bunnyCdn');

function buildVideoUrl(cdnPath) {
  if (!cdnPath) return null;
  try {
    return bunny.buildPullUrl(cdnPath);
  } catch (_) {
    return null;
  }
}

function rowToExercise(r, locale) {
  if (!r) return null;
  const isTr = String(locale || '').toLowerCase().startsWith('tr');
  return {
    id: r.id,
    slug: r.slug,
    name: (isTr && r.name_tr) ? r.name_tr : r.name_en,
    primaryMuscle: r.primary_muscle,
    secondaryMuscles: r.secondary_muscles
      ? (typeof r.secondary_muscles === 'string'
          ? JSON.parse(r.secondary_muscles)
          : r.secondary_muscles)
      : [],
    unit: r.unit,
    defaultValue: r.default_value,
    defaultSets: r.default_sets,
    difficulty: r.difficulty,
    needsEquipment: Boolean(r.needs_equipment),
    videoUrl: r.video_url || buildVideoUrl(r.video_cdn_path),
    thumbnailUrl: buildVideoUrl(r.thumbnail_path),
    description: r.description,
    tip: r.tip,
  };
}

function rowToTemplate(t, locale, previewVideoUrl, opts) {
  if (!t) return null;
  const isTr = String(locale || '').toLowerCase().startsWith('tr');
  const isPremiumTemplate = Boolean(t.is_premium);
  const isPremiumUser = Boolean(opts && opts.isPremiumUser);
  return {
    id: t.id,
    slug: t.slug,
    category: t.category,
    title: (isTr && t.title_tr) ? t.title_tr : t.title_en,
    level: t.level,
    durationMin: t.duration_min,
    thumbnailUrl: buildVideoUrl(t.thumbnail_path),
    // First exercise's CDN video URL — used as a looping thumbnail preview
    // on the home / quick / category cards. Frontend can render it via
    // ExerciseVideoPlayer.
    previewVideoUrl: previewVideoUrl || null,
    exerciseCount: t._exerciseCount ?? null,
    isPremium: isPremiumTemplate,
    // True only when this template is premium AND the requesting user is
    // not premium. Lets the client render a lock badge and route to the
    // paywall on tap without an extra round-trip.
    locked: isPremiumTemplate && !isPremiumUser,
  };
}

/**
 * Fetch the first exercise's video URL for each template id in one query,
 * then return a Map<templateId, {videoUrl, count}>.
 */
async function loadTemplatePreviews(templateIds) {
  if (templateIds.length === 0) return new Map();
  const placeholders = templateIds.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT wte.template_id, wte.position, e.video_url, e.video_cdn_path
       FROM workout_template_exercises wte
       JOIN exercises e ON e.id = wte.exercise_id
      WHERE wte.template_id IN (${placeholders})
      ORDER BY wte.template_id, wte.position`,
    templateIds,
  );
  const [counts] = await pool.execute(
    `SELECT template_id, COUNT(*) AS n
       FROM workout_template_exercises
      WHERE template_id IN (${placeholders})
      GROUP BY template_id`,
    templateIds,
  );
  const countMap = new Map(counts.map((c) => [c.template_id, c.n]));
  const result = new Map();
  for (const r of rows) {
    if (result.has(r.template_id)) continue;
    const url = r.video_url || (r.video_cdn_path ? buildVideoUrl(r.video_cdn_path) : null);
    result.set(r.template_id, { videoUrl: url, count: countMap.get(r.template_id) || 0 });
  }
  // Fill missing template ids (no exercises linked).
  for (const id of templateIds) {
    if (!result.has(id)) result.set(id, { videoUrl: null, count: countMap.get(id) || 0 });
  }
  return result;
}

async function getProgram(req, res, next) {
  try {
    const [plans] = await pool.execute(
      `SELECT * FROM user_plans
        WHERE user_id = ? AND is_archived = 0
        ORDER BY is_active DESC, updated_at DESC
        LIMIT 1`,
      [req.userId],
    );
    if (plans.length === 0) {
      return res.json({ success: true, data: { plan: null }, error: null });
    }
    const plan = plans[0];

    const [days] = await pool.execute(
      'SELECT * FROM user_plan_days WHERE plan_id = ? ORDER BY weekday',
      [plan.id],
    );

    res.json({
      success: true,
      data: {
        plan: {
          id: plan.id,
          source: plan.source,
          title: plan.title,
          goal: plan.goal,
          level: plan.level,
          durationMin: plan.duration_min,
          daysPerWeek: plan.days_per_week,
          warmupEnabled: Boolean(plan.warmup_enabled),
          stretchingEnabled: Boolean(plan.stretching_enabled),
          equipmentEnabled: Boolean(plan.equipment_enabled),
          focusAreas: plan.focus_areas
            ? (typeof plan.focus_areas === 'string'
                ? JSON.parse(plan.focus_areas)
                : plan.focus_areas)
            : [],
          isActive: Boolean(plan.is_active),
          days: days.map((d) => ({
            id: d.id,
            weekday: d.weekday,
            title: d.title,
          })),
        },
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function getDay(req, res, next) {
  try {
    const weekday = Number.parseInt(req.params.day, 10);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new AppError('day must be an integer 0..6', 400);
    }
    const locale = String(req.query.locale || req.locale || 'en');

    const [plans] = await pool.execute(
      `SELECT id FROM user_plans
        WHERE user_id = ? AND is_active = 1 AND is_archived = 0
        ORDER BY updated_at DESC
        LIMIT 1`,
      [req.userId],
    );
    if (plans.length === 0) {
      throw new AppError('No active plan', 404);
    }
    const planId = plans[0].id;

    const [days] = await pool.execute(
      'SELECT * FROM user_plan_days WHERE plan_id = ? AND weekday = ? LIMIT 1',
      [planId, weekday],
    );
    if (days.length === 0) {
      throw new AppError('Day not found in plan', 404);
    }
    const day = days[0];

    const [exercises] = await pool.execute(
      `SELECT pde.position, pde.sets, pde.reps, pde.hold_seconds, pde.rest_seconds,
              e.*
         FROM user_plan_day_exercises pde
         JOIN exercises e ON e.id = pde.exercise_id
        WHERE pde.day_id = ?
        ORDER BY pde.position`,
      [day.id],
    );

    res.json({
      success: true,
      data: {
        dayId: day.id,
        weekday: day.weekday,
        title: day.title,
        exercises: exercises.map((row) => ({
          ...rowToExercise(row, locale),
          position: row.position,
          sets: row.sets,
          reps: row.reps,
          holdSeconds: row.hold_seconds,
          restSeconds: row.rest_seconds,
        })),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function listCategories(req, res, next) {
  try {
    const [rows] = await pool.execute(
      `SELECT category, COUNT(*) AS template_count
         FROM workout_templates
        WHERE active = 1 AND category IS NOT NULL
        GROUP BY category
        ORDER BY category`,
    );
    res.json({
      success: true,
      data: {
        categories: rows.map((r) => ({
          slug: r.category,
          templateCount: r.template_count,
        })),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function getCategory(req, res, next) {
  try {
    const slug = String(req.params.slug || '').trim();
    if (!slug) throw new AppError('slug is required', 400);
    const locale = String(req.query.locale || req.locale || 'en');
    const isPremiumUser = Boolean(req.premium && req.premium.isPremium);

    const [templates] = await pool.execute(
      `SELECT * FROM workout_templates
        WHERE category = ? AND active = 1
        ORDER BY sort_order, id`,
      [slug],
    );
    const previews = await loadTemplatePreviews(templates.map((t) => t.id));
    res.json({
      success: true,
      data: {
        category: slug,
        templates: templates.map((t) => {
          const p = previews.get(t.id);
          t._exerciseCount = p?.count ?? 0;
          return rowToTemplate(t, locale, p?.videoUrl, { isPremiumUser });
        }),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function getTemplate(req, res, next) {
  try {
    const slug = String(req.params.slug || '').trim();
    if (!slug) throw new AppError('slug is required', 400);
    const locale = String(req.query.locale || req.locale || 'en');
    const isPremiumUser = Boolean(req.premium && req.premium.isPremium);

    const [templates] = await pool.execute(
      'SELECT * FROM workout_templates WHERE slug = ? AND active = 1 LIMIT 1',
      [slug],
    );
    if (templates.length === 0) {
      throw new AppError('Workout template not found', 404);
    }
    const t = templates[0];

    // Hard gate: free users can see the template card on the home/quick
    // page (where `locked: true` is rendered), but the exercise list itself
    // requires premium. 402 Payment Required so the client can route to the
    // paywall.
    if (t.is_premium && !isPremiumUser) {
      throw new AppError('Premium subscription required', 402, {
        lockedReason: 'premium_required',
        templateSlug: t.slug,
      });
    }

    const [exercises] = await pool.execute(
      `SELECT wte.position, wte.sets, wte.reps, wte.hold_seconds, wte.rest_seconds,
              e.*
         FROM workout_template_exercises wte
         JOIN exercises e ON e.id = wte.exercise_id
        WHERE wte.template_id = ?
        ORDER BY wte.position`,
      [t.id],
    );

    res.json({
      success: true,
      data: {
        template: rowToTemplate(t, locale, null, { isPremiumUser }),
        exercises: exercises.map((row) => ({
          ...rowToExercise(row, locale),
          position: row.position,
          sets: row.sets,
          reps: row.reps,
          holdSeconds: row.hold_seconds,
          restSeconds: row.rest_seconds,
        })),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function listExercises(req, res, next) {
  try {
    const locale = String(req.query.locale || req.locale || 'en');
    const muscle = req.query.muscle
      ? String(req.query.muscle).toLowerCase()
      : null;

    let sql = `SELECT * FROM exercises WHERE active = 1`;
    const params = [];
    if (muscle) {
      sql += ` AND LOWER(primary_muscle) = ?`;
      params.push(muscle);
    }
    sql += ` ORDER BY primary_muscle, name_en LIMIT 500`;

    const [rows] = await pool.execute(sql, params);
    res.json({
      success: true,
      data: {
        exercises: rows.map((r) => rowToExercise(r, locale)),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function listQuickWorkouts(req, res, next) {
  try {
    const locale = String(req.query.locale || req.locale || 'en');
    const isPremiumUser = Boolean(req.premium && req.premium.isPremium);
    const [templates] = await pool.execute(
      `SELECT * FROM workout_templates
        WHERE active = 1
        ORDER BY sort_order, id
        LIMIT 50`,
    );
    const previews = await loadTemplatePreviews(templates.map((t) => t.id));
    res.json({
      success: true,
      data: {
        quickWorkouts: templates.map((t) => {
          const p = previews.get(t.id);
          t._exerciseCount = p?.count ?? 0;
          return rowToTemplate(t, locale, p?.videoUrl, { isPremiumUser });
        }),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getProgram,
  getDay,
  listCategories,
  getCategory,
  listQuickWorkouts,
  listExercises,
  getTemplate,
};
