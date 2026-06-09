const AppError = require('../utils/appError');
const { pool } = require('../config/db');
const exerciseResolver = require('../services/exerciseResolver');
const bunny = require('../config/bunnyCdn');

const PLAN_ENUMS = {
  source: new Set(['ai', 'manual', 'template']),
  goal: new Set(['lose_weight', 'build_muscle', 'stay_fit', 'boost_energy']),
  level: new Set(['beginner', 'intermediate', 'advanced']),
};

const FOCUS_AREAS = new Set([
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

function rowToPlan(p) {
  return {
    id: p.id,
    source: p.source,
    title: p.title,
    goal: p.goal,
    level: p.level,
    durationMin: p.duration_min,
    daysPerWeek: p.days_per_week,
    warmupEnabled: Boolean(p.warmup_enabled),
    stretchingEnabled: Boolean(p.stretching_enabled),
    equipmentEnabled: Boolean(p.equipment_enabled),
    focusAreas: p.focus_areas
      ? (typeof p.focus_areas === 'string' ? JSON.parse(p.focus_areas) : p.focus_areas)
      : [],
    templateId: p.template_id,
    isActive: Boolean(p.is_active),
    isArchived: Boolean(p.is_archived),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

function rowToExercise(r, locale) {
  const isTr = String(locale || '').toLowerCase().startsWith('tr');
  return {
    id: r.id,
    slug: r.slug,
    name: (isTr && r.name_tr) ? r.name_tr : r.name_en,
    primaryMuscle: r.primary_muscle,
    unit: r.unit,
    videoUrl: r.video_url || buildVideoUrl(r.video_cdn_path),
    thumbnailUrl: buildVideoUrl(r.thumbnail_path),
  };
}

/**
 * Validate + normalize the create-plan payload. Returns a clean object.
 */
function validatePlanInput(body) {
  if (!body || typeof body !== 'object') {
    throw new AppError('Request body is required', 400);
  }
  const source = String(body.source || 'manual').toLowerCase();
  if (!PLAN_ENUMS.source.has(source)) {
    throw new AppError(`source must be one of ${[...PLAN_ENUMS.source].join('|')}`, 400);
  }
  const title = String(body.title || '').trim();
  if (!title) throw new AppError('title is required', 400);

  function pickEnum(key, allowed) {
    if (body[key] === null || body[key] === undefined) return null;
    const v = String(body[key]);
    if (!allowed.has(v)) throw new AppError(`Invalid ${key}: ${v}`, 400);
    return v;
  }
  function pickInt(key, min, max, fallback = null) {
    if (body[key] === undefined || body[key] === null) return fallback;
    const n = Number.parseInt(body[key], 10);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new AppError(`Invalid ${key}: ${body[key]}`, 400);
    }
    return n;
  }

  const focusAreas = Array.isArray(body.focusAreas)
    ? body.focusAreas.map(String).filter((v) => FOCUS_AREAS.has(v))
    : [];

  const days = Array.isArray(body.days) ? body.days : [];
  const seenWeekday = new Set();
  const cleanDays = days.map((d, dIdx) => {
    const weekday = pickInt.call(null, undefined);
    if (!d || typeof d !== 'object') {
      throw new AppError(`days[${dIdx}] must be an object`, 400);
    }
    const w = Number.parseInt(d.weekday, 10);
    if (!Number.isInteger(w) || w < 0 || w > 6) {
      throw new AppError(`days[${dIdx}].weekday must be 0..6`, 400);
    }
    if (seenWeekday.has(w)) {
      throw new AppError(`Duplicate day: weekday=${w}`, 400);
    }
    seenWeekday.add(w);

    const exercises = Array.isArray(d.exercises) ? d.exercises : [];
    // De-duplicate a day's exercises by slug (falling back to exerciseId)
    // BEFORE insert — a day must never store the same exercise twice. First
    // occurrence wins (mirrors the client's own per-day de-dup), and positions
    // are renumbered contiguously afterward. This is the in-memory guard; the
    // UNIQUE(day_id, exercise_id) constraint on user_plan_day_exercises is the
    // DB-level backstop for anything that slips through (e.g. the same exercise
    // sent once by slug and once by exerciseId).
    const seenExercise = new Set();
    const cleanExercises = [];
    exercises.forEach((e, eIdx) => {
      if (!e || typeof e !== 'object') {
        throw new AppError(`days[${dIdx}].exercises[${eIdx}] must be an object`, 400);
      }
      const slug = String(e.slug || e.exerciseSlug || '').trim();
      const exerciseId = e.exerciseId ? Number.parseInt(e.exerciseId, 10) : null;
      if (!slug && !exerciseId) {
        throw new AppError(
          `days[${dIdx}].exercises[${eIdx}] must include exerciseId or slug`,
          400,
        );
      }
      const dedupeKey = slug ? `slug:${slug.toLowerCase()}` : `id:${exerciseId}`;
      if (seenExercise.has(dedupeKey)) return; // duplicate within this day — drop it
      seenExercise.add(dedupeKey);

      const sets = Math.max(1, Math.min(10, Number.parseInt(e.sets, 10) || 3));
      let reps = null;
      let holdSeconds = null;
      if (e.reps !== undefined && e.reps !== null) {
        reps = Math.max(1, Math.min(200, Number.parseInt(e.reps, 10) || 0));
      }
      if (e.holdSeconds !== undefined && e.holdSeconds !== null) {
        holdSeconds = Math.max(1, Math.min(900, Number.parseInt(e.holdSeconds, 10) || 0));
      }
      const restSeconds = Math.max(0, Math.min(600, Number.parseInt(e.restSeconds, 10) || 30));
      cleanExercises.push({
        slug,
        exerciseId,
        name: e.name ? String(e.name).slice(0, 160) : null,
        unit: holdSeconds ? 'seconds' : 'reps',
        primaryMuscle: e.primaryMuscle ? String(e.primaryMuscle).slice(0, 64) : null,
        sets,
        reps,
        holdSeconds,
        restSeconds,
        position: cleanExercises.length + 1, // contiguous 1..N after de-dup
      });
    });

    return {
      weekday: w,
      title: d.title ? String(d.title).slice(0, 120) : null,
      exercises: cleanExercises,
    };
  });

  return {
    source,
    title: title.slice(0, 160),
    goal: pickEnum('goal', PLAN_ENUMS.goal),
    level: pickEnum('level', PLAN_ENUMS.level),
    durationMin: pickInt('durationMin', 5, 240, 20),
    daysPerWeek: pickInt('daysPerWeek', 1, 7, Math.max(1, cleanDays.length || 1)),
    warmupEnabled: body.warmupEnabled === true,
    stretchingEnabled: body.stretchingEnabled !== false,
    equipmentEnabled: body.equipmentEnabled === true,
    focusAreas,
    templateId: pickInt('templateId', 1, Number.MAX_SAFE_INTEGER, null),
    isActive: body.isActive !== false,
    days: cleanDays,
  };
}

async function listPlans(req, res, next) {
  try {
    const includeArchived = String(req.query.archived || '').toLowerCase() === '1'
      || String(req.query.archived || '').toLowerCase() === 'true';
    const where = includeArchived ? '1=1' : 'is_archived = 0';
    const [rows] = await pool.execute(
      `SELECT * FROM user_plans
        WHERE user_id = ? AND ${where}
        ORDER BY is_active DESC, updated_at DESC`,
      [req.userId],
    );
    res.json({
      success: true,
      data: { plans: rows.map(rowToPlan) },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function getPlan(req, res, next) {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) throw new AppError('id must be integer', 400);
    const locale = String(req.query.locale || req.locale || 'en');

    const [plans] = await pool.execute(
      'SELECT * FROM user_plans WHERE id = ? AND user_id = ? LIMIT 1',
      [id, req.userId],
    );
    if (plans.length === 0) throw new AppError('Plan not found', 404);
    const plan = plans[0];

    const [days] = await pool.execute(
      'SELECT * FROM user_plan_days WHERE plan_id = ? ORDER BY weekday',
      [plan.id],
    );

    const dayIds = days.map((d) => d.id);
    let exercisesByDay = {};
    if (dayIds.length > 0) {
      const placeholders = dayIds.map(() => '?').join(',');
      const [exRows] = await pool.execute(
        `SELECT pde.day_id, pde.position, pde.sets, pde.reps,
                pde.hold_seconds, pde.rest_seconds, e.*
           FROM user_plan_day_exercises pde
           JOIN exercises e ON e.id = pde.exercise_id
          WHERE pde.day_id IN (${placeholders})
          ORDER BY pde.day_id, pde.position`,
        dayIds,
      );
      for (const row of exRows) {
        const k = row.day_id;
        if (!exercisesByDay[k]) exercisesByDay[k] = [];
        exercisesByDay[k].push({
          ...rowToExercise(row, locale),
          position: row.position,
          sets: row.sets,
          reps: row.reps,
          holdSeconds: row.hold_seconds,
          restSeconds: row.rest_seconds,
        });
      }
    }

    res.json({
      success: true,
      data: {
        plan: {
          ...rowToPlan(plan),
          days: days.map((d) => ({
            id: d.id,
            weekday: d.weekday,
            title: d.title,
            exercises: exercisesByDay[d.id] || [],
          })),
        },
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

// Maximum number of active (non-archived) plans a free user may own.
// Per `docs/HomiFit – Premium Paket Özellikleri.docx` the free tier is
// limited to a small handful of programs; the spec example is "5". Adjust
// here if Product changes the number.
const FREE_PLAN_LIMIT = 5;

async function createPlan(req, res, next) {
  try {
    const input = validatePlanInput(req.body);
    const isPremium = Boolean(req.premium && req.premium.isPremium);

    // Premium gates (spec: "Tüm antrenman seviyelerine erişim", "Sınırsız
    // egzersiz programına erişim"):
    //   1. Free users can't create `advanced` plans.
    //   2. Free users are capped at FREE_PLAN_LIMIT active plans.
    if (!isPremium && input.level === 'advanced') {
      throw new AppError(
        'Advanced-level plans are a Premium feature',
        402,
        { lockedReason: 'premium_required', requiredLevel: 'advanced' },
      );
    }
    if (!isPremium) {
      const [countRows] = await pool.execute(
        `SELECT COUNT(*) AS n FROM user_plans
          WHERE user_id = ? AND is_archived = 0`,
        [req.userId],
      );
      const currentCount = (countRows[0] && countRows[0].n) || 0;
      if (currentCount >= FREE_PLAN_LIMIT) {
        throw new AppError(
          `Free users can have up to ${FREE_PLAN_LIMIT} active plans. Upgrade to add more.`,
          402,
          { lockedReason: 'premium_required', planLimit: FREE_PLAN_LIMIT },
        );
      }
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // If isActive=true, deactivate every other plan for this user first.
      if (input.isActive) {
        await conn.execute(
          'UPDATE user_plans SET is_active = 0 WHERE user_id = ? AND is_active = 1',
          [req.userId],
        );
      }

      const [insertPlan] = await conn.execute(
        `INSERT INTO user_plans
           (user_id, source, title, goal, level, duration_min, days_per_week,
            warmup_enabled, stretching_enabled, equipment_enabled, focus_areas,
            template_id, is_active, is_archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          req.userId,
          input.source,
          input.title,
          input.goal,
          input.level,
          input.durationMin,
          input.daysPerWeek,
          input.warmupEnabled ? 1 : 0,
          input.stretchingEnabled ? 1 : 0,
          input.equipmentEnabled ? 1 : 0,
          JSON.stringify(input.focusAreas),
          input.templateId,
          input.isActive ? 1 : 0,
        ],
      );
      const planId = insertPlan.insertId;

      for (const day of input.days) {
        const [insertDay] = await conn.execute(
          `INSERT INTO user_plan_days (plan_id, weekday, title)
           VALUES (?, ?, ?)`,
          [planId, day.weekday, day.title],
        );
        const dayId = insertDay.insertId;

        for (const ex of day.exercises) {
          let exerciseId = ex.exerciseId;
          if (!exerciseId) {
            exerciseId = await exerciseResolver.resolveOrCreate({
              slug: ex.slug,
              name: ex.name,
              unit: ex.unit,
              primaryMuscle: ex.primaryMuscle,
              conn,
            });
          }
          // Idempotent insert: if the same (day_id, exercise_id) is attempted
          // (e.g. a dup that slipped past the in-memory de-dup above), update
          // the existing row's parameters instead of creating a duplicate. The
          // row's original position is left intact. Backed by the
          // UNIQUE(day_id, exercise_id) constraint (migration 008).
          await conn.execute(
            `INSERT INTO user_plan_day_exercises
               (day_id, exercise_id, position, sets, reps, hold_seconds, rest_seconds)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               sets         = VALUES(sets),
               reps         = VALUES(reps),
               hold_seconds = VALUES(hold_seconds),
               rest_seconds = VALUES(rest_seconds)`,
            [
              dayId,
              exerciseId,
              ex.position,
              ex.sets,
              ex.reps,
              ex.holdSeconds,
              ex.restSeconds,
            ],
          );
        }
      }

      await conn.commit();

      // Re-fetch the canonical shape for the response.
      req.params = { id: planId };
      return getPlan(req, res, next);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    next(error);
  }
}

async function activatePlan(req, res, next) {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) throw new AppError('id must be integer', 400);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [own] = await conn.execute(
        'SELECT id FROM user_plans WHERE id = ? AND user_id = ? LIMIT 1',
        [id, req.userId],
      );
      if (own.length === 0) throw new AppError('Plan not found', 404);

      await conn.execute(
        'UPDATE user_plans SET is_active = 0 WHERE user_id = ?',
        [req.userId],
      );
      await conn.execute(
        'UPDATE user_plans SET is_active = 1, is_archived = 0 WHERE id = ?',
        [id],
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    req.params = { id };
    return getPlan(req, res, next);
  } catch (error) {
    next(error);
  }
}

async function archivePlan(req, res, next) {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) throw new AppError('id must be integer', 400);
    const [result] = await pool.execute(
      `UPDATE user_plans
          SET is_archived = 1, is_active = 0
        WHERE id = ? AND user_id = ?`,
      [id, req.userId],
    );
    if (result.affectedRows === 0) throw new AppError('Plan not found', 404);
    res.json({ success: true, data: { archived: id }, error: null });
  } catch (error) {
    next(error);
  }
}

async function deletePlan(req, res, next) {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) throw new AppError('id must be integer', 400);
    const [result] = await pool.execute(
      'DELETE FROM user_plans WHERE id = ? AND user_id = ?',
      [id, req.userId],
    );
    if (result.affectedRows === 0) throw new AppError('Plan not found', 404);
    res.json({ success: true, data: { deleted: id }, error: null });
  } catch (error) {
    next(error);
  }
}

async function renamePlan(req, res, next) {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) throw new AppError('id must be integer', 400);
    const newTitle = String((req.body && req.body.title) || '').trim();
    if (!newTitle) throw new AppError('title is required', 400);
    const [result] = await pool.execute(
      `UPDATE user_plans SET title = ? WHERE id = ? AND user_id = ?`,
      [newTitle.slice(0, 160), id, req.userId],
    );
    if (result.affectedRows === 0) throw new AppError('Plan not found', 404);
    res.json({ success: true, data: { id, title: newTitle }, error: null });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listPlans,
  getPlan,
  createPlan,
  activatePlan,
  archivePlan,
  deletePlan,
  renamePlan,
  // Exported for unit testing the per-day exercise de-dup.
  validatePlanInput,
};
