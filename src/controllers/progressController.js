const AppError = require('../utils/appError');
const { pool } = require('../config/db');
const bunnyCdn = require('../config/bunnyCdn');

function thumbUrl(path) {
  if (!path) return null;
  try {
    return bunnyCdn.buildPullUrl(path);
  } catch (_) {
    return null;
  }
}

// Mirror of workoutController.deriveThumbnailPath: when an exercise has no
// thumbnail_path, derive `exercise-thumbs/<clean>.jpg` from its video filename
// (stripping the trailing resolution suffix) so history rows still get a real
// per-exercise poster instead of falling back to the neutral muscle icon.
const RESOLUTION_SUFFIX = /-(?:144|240|360|480|540|720|1080|1440|2160)$/;

function deriveThumbnailPath(videoCdnPath) {
  if (!videoCdnPath || typeof videoCdnPath !== 'string') return null;
  const file = videoCdnPath.split('/').filter(Boolean).pop();
  if (!file) return null;
  let base = file.replace(/\.[^.]+$/, '');
  base = base.replace(RESOLUTION_SUFFIX, '');
  if (!base) return null;
  return `exercise-thumbs/${base}.jpg`;
}

// Collapse a raw muscle name (primary or secondary) into one of the canonical
// focus categories the client localises in `_muscleLabel`. Keeps the Training
// Insights muscle chart clean and translated instead of leaking raw DB strings.
function muscleToFocus(muscle) {
  const m = String(muscle || '').toLowerCase();
  if (!m) return null;
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
 * Batch-load the first exercise (lowest position) for a set of join-table
 * groups, so each history row can show a real per-exercise image — the same
 * gendered-photo / video-poster source the rest of the app uses — instead of
 * the (almost always NULL) `workout_templates.thumbnail_path`.
 *
 * @param {string} joinTable  'workout_template_exercises' | 'user_plan_day_exercises'
 * @param {string} groupCol   'template_id' | 'day_id'
 * @returns {Promise<Map<number,{slug:string, videoUrl:string|null}>>}
 */
async function loadFirstExercise(joinTable, groupCol, ids) {
  if (!ids.length) return new Map();
  const ph = ids.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT j.${groupCol} AS gid, e.slug, e.video_url, e.video_cdn_path,
            e.thumbnail_path, e.primary_muscle
       FROM ${joinTable} j
       JOIN exercises e ON e.id = j.exercise_id
      WHERE j.${groupCol} IN (${ph})
      ORDER BY j.${groupCol}, j.position`,
    ids,
  );
  const map = new Map();
  for (const r of rows) {
    if (map.has(r.gid)) continue; // first row per group = lowest position
    map.set(r.gid, {
      slug: r.slug,
      videoUrl: r.video_url || thumbUrl(r.video_cdn_path),
      // Real per-exercise poster (same source the plan/home cards use), so the
      // history row shows the workout's photo even when there's no gendered
      // demo photo and the template thumbnail is NULL.
      thumbnailUrl:
        thumbUrl(r.thumbnail_path) ||
        thumbUrl(deriveThumbnailPath(r.video_cdn_path)),
      primaryMuscle: r.primary_muscle || null,
    });
  }
  return map;
}

function isoDate(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  // Format in the local timezone — MariaDB stores DATE as wall-clock and we
  // don't want a UTC roundtrip to shift the day.
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Compute the current streak count by walking backwards from today through
 * streak_log days, breaking on the first gap of 1+ days.
 */
async function computeStreak(userId) {
  const [rows] = await pool.execute(
    `SELECT log_date
       FROM streak_log
      WHERE user_id = ?
      ORDER BY log_date DESC
      LIMIT 365`,
    [userId],
  );
  if (rows.length === 0) return 0;

  let streak = 0;
  let cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  for (const row of rows) {
    const ds = isoDate(row.log_date);
    const cs = isoDate(cursor);
    if (ds === cs) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }
    // First row may equal yesterday if the user hasn't logged today yet.
    if (streak === 0) {
      cursor.setDate(cursor.getDate() - 1);
      const csYesterday = isoDate(cursor);
      if (ds === csYesterday) {
        streak += 1;
        cursor.setDate(cursor.getDate() - 1);
        continue;
      }
    }
    break;
  }
  return streak;
}

async function recomputeAndStoreCounters(userId) {
  const [aggRows] = await pool.execute(
    `SELECT
        COUNT(*)            AS total_workouts_logged,
        COALESCE(SUM(workouts_done), 0) AS total_workouts,
        COALESCE(SUM(minutes_done), 0)  AS total_minutes,
        MAX(log_date)       AS last_log_date
       FROM streak_log
      WHERE user_id = ?`,
    [userId],
  );
  const agg = aggRows[0] || {};
  const current = await computeStreak(userId);

  // Weekly bucket: count days within current ISO week (Mon..Sun).
  const now = new Date();
  const day = now.getDay();          // 0=Sun..6=Sat
  const offsetToMon = (day === 0 ? 6 : day - 1);
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - offsetToMon);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  const [weekRows] = await pool.execute(
    `SELECT COUNT(*) AS weekly_done
       FROM streak_log
      WHERE user_id = ?
        AND log_date BETWEEN ? AND ?`,
    [userId, isoDate(monday), isoDate(sunday)],
  );
  const weeklyDone = weekRows[0]?.weekly_done ?? 0;

  await pool.execute(
    `INSERT INTO user_streak_counters
       (user_id, current_streak, longest_streak, total_workouts, total_minutes, weekly_done, last_workout_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       current_streak  = VALUES(current_streak),
       longest_streak  = GREATEST(longest_streak, VALUES(current_streak)),
       total_workouts  = VALUES(total_workouts),
       total_minutes   = VALUES(total_minutes),
       weekly_done     = VALUES(weekly_done),
       last_workout_at = VALUES(last_workout_at)`,
    [
      userId,
      current,
      current,
      agg.total_workouts || 0,
      agg.total_minutes || 0,
      weeklyDone,
      agg.last_log_date ? new Date(agg.last_log_date) : null,
    ],
  );

  return { current, longest: current, totalWorkouts: agg.total_workouts || 0, totalMinutes: agg.total_minutes || 0, weeklyDone };
}

async function listDays(req, res, next) {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 365);
    const [rows] = await pool.execute(
      `SELECT log_date, workouts_done, minutes_done
         FROM streak_log
        WHERE user_id = ?
        ORDER BY log_date DESC
        LIMIT ?`,
      [req.userId, limit],
    );
    res.json({
      success: true,
      data: {
        days: rows.map((r) => ({
          date: isoDate(r.log_date),
          workouts: r.workouts_done,
          minutes: r.minutes_done,
        })),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function upsertDay(req, res, next) {
  try {
    const dayStr = String(req.params.day || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) {
      throw new AppError('day must be YYYY-MM-DD', 400);
    }
    const body = req.body || {};
    const workouts = Math.max(0, Number.parseInt(body.workouts, 10) || 1);
    const minutes = Math.max(0, Number.parseInt(body.minutes, 10) || 0);
    const planDayId = body.planDayId ? Number.parseInt(body.planDayId, 10) : null;
    const templateId = body.templateId ? Number.parseInt(body.templateId, 10) : null;
    const exercisesDone = Math.max(0, Number.parseInt(body.exercisesDone, 10) || 0);
    const exercisesTotal = Math.max(0, Number.parseInt(body.exercisesTotal, 10) || 0);
    const calories = body.calories ? Number.parseInt(body.calories, 10) : null;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. Append a workout_sessions row.
      await conn.execute(
        `INSERT INTO workout_sessions
           (user_id, plan_day_id, template_id, source, started_at, completed_at,
            duration_sec, exercises_done, exercises_total, calories_kcal)
         VALUES (?, ?, ?, ?, CONCAT(?, ' 00:00:00'), CURRENT_TIMESTAMP, ?, ?, ?, ?)`,
        [
          req.userId,
          planDayId,
          templateId,
          templateId ? 'quick' : (planDayId ? 'plan' : 'custom'),
          dayStr,
          minutes * 60,
          exercisesDone,
          exercisesTotal,
          calories,
        ],
      );

      // 2. Upsert the streak_log row.
      await conn.execute(
        `INSERT INTO streak_log (user_id, log_date, workouts_done, minutes_done)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           workouts_done = workouts_done + VALUES(workouts_done),
           minutes_done  = minutes_done  + VALUES(minutes_done)`,
        [req.userId, dayStr, workouts, minutes],
      );

      // 3. Append a progress_log entry.
      await conn.execute(
        `INSERT INTO progress_log (user_id, event_type, amount, meta, occurred_at)
         VALUES (?, 'workout_completed', ?, ?, CONCAT(?, ' 12:00:00'))`,
        [
          req.userId,
          minutes,
          JSON.stringify({ workouts, exercisesDone, exercisesTotal, calories }),
          dayStr,
        ],
      );

      // 4. Clear any saved in-progress resume state for this workout — the
      //    session is now complete, so re-entering should start fresh.
      const scopeKey = scopeKeyFor(planDayId, templateId);
      if (scopeKey) {
        await conn.execute(
          `DELETE FROM workout_session_progress
            WHERE user_id = ? AND scope_key = ?`,
          [req.userId, scopeKey],
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const counters = await recomputeAndStoreCounters(req.userId);
    res.json({
      success: true,
      data: { date: dayStr, counters },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

// ── In-progress workout resume state ───────────────────────────────────────
// Saves / loads the last exercise+set index the user reached inside a workout
// that was started but not completed, so re-entering resumes from where they
// left off. Scope is the plan day (or quick-workout template); cleared on the
// matching completion in upsertDay.

function scopeKeyFor(planDayId, templateId) {
  if (planDayId) return `day:${planDayId}`;
  if (templateId) return `tpl:${templateId}`;
  return null;
}

async function getActiveSession(req, res, next) {
  try {
    const planDayId = req.query.planDayId
      ? Number.parseInt(req.query.planDayId, 10)
      : null;
    const templateId = req.query.templateId
      ? Number.parseInt(req.query.templateId, 10)
      : null;
    const scopeKey = scopeKeyFor(planDayId, templateId);
    if (!scopeKey) {
      res.json({ success: true, data: { progress: null }, error: null });
      return;
    }
    const [rows] = await pool.execute(
      `SELECT exercise_index, set_index
         FROM workout_session_progress
        WHERE user_id = ? AND scope_key = ?
        LIMIT 1`,
      [req.userId, scopeKey],
    );
    const row = rows[0];
    res.json({
      success: true,
      data: {
        progress: row
          ? {
              exerciseIndex: Number(row.exercise_index) || 0,
              setIndex: Number(row.set_index) || 0,
            }
          : null,
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function saveActiveSession(req, res, next) {
  try {
    const body = req.body || {};
    const planDayId = body.planDayId
      ? Number.parseInt(body.planDayId, 10)
      : null;
    const templateId = body.templateId
      ? Number.parseInt(body.templateId, 10)
      : null;
    const scopeKey = scopeKeyFor(planDayId, templateId);
    if (!scopeKey) {
      throw new AppError('planDayId or templateId is required', 400);
    }
    const exerciseIndex = Math.max(0, Number.parseInt(body.exerciseIndex, 10) || 0);
    const setIndex = Math.max(0, Number.parseInt(body.setIndex, 10) || 0);

    await pool.execute(
      `INSERT INTO workout_session_progress
         (user_id, scope_key, plan_day_id, template_id, exercise_index, set_index)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         plan_day_id    = VALUES(plan_day_id),
         template_id    = VALUES(template_id),
         exercise_index = VALUES(exercise_index),
         set_index      = VALUES(set_index)`,
      [req.userId, scopeKey, planDayId, templateId, exerciseIndex, setIndex],
    );

    res.json({ success: true, data: { ok: true }, error: null });
  } catch (error) {
    next(error);
  }
}

async function clearActiveSession(req, res, next) {
  try {
    const planDayId = req.query.planDayId
      ? Number.parseInt(req.query.planDayId, 10)
      : null;
    const templateId = req.query.templateId
      ? Number.parseInt(req.query.templateId, 10)
      : null;
    const scopeKey = scopeKeyFor(planDayId, templateId);
    if (scopeKey) {
      await pool.execute(
        `DELETE FROM workout_session_progress
          WHERE user_id = ? AND scope_key = ?`,
        [req.userId, scopeKey],
      );
    }
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (error) {
    next(error);
  }
}

async function getSummary(req, res, next) {
  try {
    const [weekRows] = await pool.execute(
      `SELECT
          COALESCE(SUM(workouts_done),0) AS workouts,
          COALESCE(SUM(minutes_done),0)  AS minutes
         FROM streak_log
        WHERE user_id = ?
          AND log_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`,
      [req.userId],
    );
    const [monthRows] = await pool.execute(
      `SELECT
          COALESCE(SUM(workouts_done),0) AS workouts,
          COALESCE(SUM(minutes_done),0)  AS minutes
         FROM streak_log
        WHERE user_id = ?
          AND log_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`,
      [req.userId],
    );
    const [allRows] = await pool.execute(
      `SELECT
          COALESCE(SUM(workouts_done),0) AS workouts,
          COALESCE(SUM(minutes_done),0)  AS minutes
         FROM streak_log
        WHERE user_id = ?`,
      [req.userId],
    );

    // SUM()/COALESCE come back as strings via the driver — coerce to numbers
    // so the client doesn't have to defensively parse (and so old clients that
    // `as num`-cast don't collapse to zero).
    res.json({
      success: true,
      data: {
        last7Days:  { workouts: Number(weekRows[0].workouts),  minutes: Number(weekRows[0].minutes) },
        last30Days: { workouts: Number(monthRows[0].workouts), minutes: Number(monthRows[0].minutes) },
        allTime:    { workouts: Number(allRows[0].workouts),   minutes: Number(allRows[0].minutes) },
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

// ── Stats screen (Profile → Your Stats, Figma 2539:2767) ──────────────────
// One aggregation call powering the whole screen. Everything is derived from
// the existing streak_log / workout_sessions / template tables — no new
// schema. `range` shifts the totals + muscle-focus window; the weekly digest
// and personal records stay fixed (this-week / lifetime) by design.

/** Midnight (local) of the range start: week=Mon of ISO week, month=-29d, year=-364d. */
function rangeStartDate(range) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (range === 'year') {
    const d = new Date(now);
    d.setDate(d.getDate() - 364);
    return d;
  }
  if (range === 'month') {
    const d = new Date(now);
    d.setDate(d.getDate() - 29);
    return d;
  }
  // week → Monday of the current ISO week (matches the digest window).
  const dow = now.getDay(); // 0=Sun..6=Sat
  const offsetToMon = dow === 0 ? 6 : dow - 1;
  const d = new Date(now);
  d.setDate(d.getDate() - offsetToMon);
  return d;
}

/** Walk every logged day ASC and return the longest consecutive run + its span. */
async function computeLongestStreakSpan(userId) {
  const [rows] = await pool.execute(
    `SELECT log_date FROM streak_log WHERE user_id = ? ORDER BY log_date ASC`,
    [userId],
  );
  if (rows.length === 0) return { days: 0, startDate: null, endDate: null };

  let bestLen = 0;
  let bestStart = null;
  let bestEnd = null;
  let curLen = 0;
  let curStart = null;
  let prevDate = null; // Date object at midnight

  for (const row of rows) {
    const ds = isoDate(row.log_date);
    if (prevDate) {
      const expected = new Date(prevDate);
      expected.setDate(expected.getDate() + 1);
      if (isoDate(expected) === ds) {
        curLen += 1;
      } else {
        curLen = 1;
        curStart = ds;
      }
    } else {
      curLen = 1;
      curStart = ds;
    }
    if (curLen > bestLen) {
      bestLen = curLen;
      bestStart = curStart;
      bestEnd = ds;
    }
    prevDate = new Date(`${ds}T00:00:00`);
  }
  return { days: bestLen, startDate: bestStart, endDate: bestEnd };
}

async function getStats(req, res, next) {
  try {
    const userId = req.userId;
    const rangeRaw = String(req.query.range || 'week').toLowerCase();
    const range = ['week', 'month', 'year'].includes(rangeRaw) ? rangeRaw : 'week';
    const startStr = isoDate(rangeStartDate(range));

    // Current ISO week (Mon..Sun) for the fixed weekly digest.
    const now = new Date();
    const dow = now.getDay();
    const offsetToMon = dow === 0 ? 6 : dow - 1;
    const monday = new Date(now);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - offsetToMon);
    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(d.getDate() + i);
      weekDays.push(isoDate(d));
    }

    // ── Weekly digest: per-weekday minutes for the current week. ──
    const wkPlaceholders = weekDays.map(() => '?').join(',');
    const [digestRows] = await pool.execute(
      `SELECT log_date, minutes_done, workouts_done
         FROM streak_log
        WHERE user_id = ? AND log_date IN (${wkPlaceholders})`,
      [userId, ...weekDays],
    );
    const digestByDate = new Map(
      digestRows.map((r) => [isoDate(r.log_date), r]),
    );
    const digest = weekDays.map((d, i) => {
      const row = digestByDate.get(d);
      const minutes = row ? Number(row.minutes_done) || 0 : 0;
      return { weekday: i, minutes, active: minutes > 0 };
    });

    // ── Totals over the selected range. ──
    const [totalRows] = await pool.execute(
      `SELECT COALESCE(SUM(workouts_done),0) AS workouts,
              COALESCE(SUM(minutes_done),0)  AS minutes
         FROM streak_log
        WHERE user_id = ? AND log_date >= ?`,
      [userId, startStr],
    );
    const workouts = Number(totalRows[0].workouts) || 0;
    const activeMinutes = Number(totalRows[0].minutes) || 0;

    const [sessRows] = await pool.execute(
      `SELECT COALESCE(SUM(calories_kcal),0) AS kcal,
              COALESCE(AVG(NULLIF(duration_sec,0)),0) AS avg_sec
         FROM workout_sessions
        WHERE user_id = ? AND completed_at IS NOT NULL
          AND completed_at >= CONCAT(?, ' 00:00:00')`,
      [userId, startStr],
    );
    let calories = Number(sessRows[0].kcal) || 0;
    if (calories === 0) calories = activeMinutes * 7; // ~7 kcal/min estimate
    const avgSessionSec = Math.round(Number(sessRows[0].avg_sec) || 0);

    // ── Weekly goal ring (always the current ISO week). ──
    const [cntRows] = await pool.execute(
      `SELECT weekly_done, weekly_goal FROM user_streak_counters WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    const goalDone = cntRows[0] ? Number(cntRows[0].weekly_done) || 0 : 0;
    const goalTarget = cntRows[0] ? Number(cntRows[0].weekly_goal) || 5 : 5;
    const goalPercent = goalTarget > 0
      ? Math.min(100, Math.round((goalDone / goalTarget) * 100))
      : 0;

    const [planRows] = await pool.execute(
      `SELECT title FROM user_plans
        WHERE user_id = ? AND is_active = 1 AND is_archived = 0
        ORDER BY updated_at DESC LIMIT 1`,
      [userId],
    );
    const planTitle = planRows[0] ? planRows[0].title : null;

    // ── Muscle focus (sets per primary_muscle) over the range. Combine
    //    template-based quick workouts and plan-day workouts. ──
    const [tplMuscle] = await pool.execute(
      `SELECT e.primary_muscle AS muscle, COALESCE(SUM(wte.sets),0) AS sets
         FROM workout_sessions ws
         JOIN workout_template_exercises wte ON wte.template_id = ws.template_id
         JOIN exercises e ON e.id = wte.exercise_id
        WHERE ws.user_id = ? AND ws.completed_at IS NOT NULL
          AND ws.completed_at >= CONCAT(?, ' 00:00:00')
          AND ws.template_id IS NOT NULL AND e.primary_muscle IS NOT NULL
        GROUP BY e.primary_muscle`,
      [userId, startStr],
    );
    const [planMuscle] = await pool.execute(
      `SELECT e.primary_muscle AS muscle, COALESCE(SUM(pde.sets),0) AS sets
         FROM workout_sessions ws
         JOIN user_plan_day_exercises pde ON pde.day_id = ws.plan_day_id
         JOIN exercises e ON e.id = pde.exercise_id
        WHERE ws.user_id = ? AND ws.completed_at IS NOT NULL
          AND ws.completed_at >= CONCAT(?, ' 00:00:00')
          AND ws.plan_day_id IS NOT NULL AND e.primary_muscle IS NOT NULL
        GROUP BY e.primary_muscle`,
      [userId, startStr],
    );
    const muscleMap = new Map();
    for (const r of [...tplMuscle, ...planMuscle]) {
      const key = String(r.muscle);
      muscleMap.set(key, (muscleMap.get(key) || 0) + (Number(r.sets) || 0));
    }
    const muscleFocus = [...muscleMap.entries()]
      .map(([muscle, sets]) => ({ muscle, sets }))
      .sort((a, b) => b.sets - a.sets)
      .slice(0, 6);

    // ── Personal records (lifetime). ──
    const longestStreak = await computeLongestStreakSpan(userId);

    const [longSessRows] = await pool.execute(
      `SELECT ws.duration_sec, ws.template_id, t.slug AS template_slug,
              t.title_en, t.title_tr
         FROM workout_sessions ws
         LEFT JOIN workout_templates t ON t.id = ws.template_id
        WHERE ws.user_id = ? AND ws.duration_sec IS NOT NULL AND ws.duration_sec > 0
        ORDER BY ws.duration_sec DESC LIMIT 1`,
      [userId],
    );
    const ls = longSessRows[0];
    const longestSession = ls
      ? {
          sec: Number(ls.duration_sec) || 0,
          templateSlug: ls.template_slug || null,
          titleEn: ls.title_en || null,
          titleTr: ls.title_tr || null,
        }
      : null;

    const [calRows] = await pool.execute(
      `SELECT MAX(calories_kcal) AS kcal FROM workout_sessions
        WHERE user_id = ? AND calories_kcal IS NOT NULL`,
      [userId],
    );
    const mostCalories = calRows[0] && calRows[0].kcal != null
      ? Number(calRows[0].kcal)
      : 0;

    res.json({
      success: true,
      data: {
        range,
        digest,
        totals: { workouts, activeMinutes, calories, avgSessionSec },
        weeklyGoal: {
          done: goalDone,
          goal: goalTarget,
          percent: goalPercent,
          planTitle,
        },
        muscleFocus,
        records: {
          longestStreak,
          longestSession,
          mostCalories,
        },
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function getStreak(req, res, next) {
  try {
    const [counters] = await pool.execute(
      'SELECT * FROM user_streak_counters WHERE user_id = ? LIMIT 1',
      [req.userId],
    );
    let row = counters[0];
    if (!row) {
      const fresh = await recomputeAndStoreCounters(req.userId);
      const [refreshed] = await pool.execute(
        'SELECT * FROM user_streak_counters WHERE user_id = ? LIMIT 1',
        [req.userId],
      );
      row = refreshed[0] || {
        current_streak: fresh.current,
        longest_streak: fresh.longest,
        total_workouts: fresh.totalWorkouts,
        total_minutes: fresh.totalMinutes,
        weekly_done: fresh.weeklyDone,
      };
    }

    // Last 7 days as boolean dot row (Mon..Sun of current ISO week).
    const now = new Date();
    const dow = now.getDay();
    const offsetToMon = (dow === 0 ? 6 : dow - 1);
    const monday = new Date(now);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - offsetToMon);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(d.getDate() + i);
      days.push(isoDate(d));
    }
    const placeholders = days.map(() => '?').join(',');
    const [logged] = await pool.execute(
      `SELECT log_date FROM streak_log
        WHERE user_id = ? AND log_date IN (${placeholders})`,
      [req.userId, ...days],
    );
    const set = new Set(logged.map((r) => isoDate(r.log_date)));
    const weekProgress = days.map((d) => set.has(d));

    res.json({
      success: true,
      data: {
        currentStreak: row.current_streak,
        longestStreak: row.longest_streak,
        totalWorkouts: row.total_workouts,
        totalMinutes: row.total_minutes,
        weeklyDone: row.weekly_done,
        weeklyGoal: row.weekly_goal,
        extendedUnlocked: Boolean(row.extended_unlocked),
        rewardClaimed: Boolean(row.reward_claimed),
        discountActive: Boolean(row.discount_active),
        discountPercent: row.discount_percent,
        weekProgress,
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

// ── Workout History list (Profile → Workout History, Figma 2516:2232) ──────

async function getHistory(req, res, next) {
  try {
    const userId = req.userId;

    // Skip content-less junk logs: a session with no duration AND no link to a
    // template / plan day is an aborted or accidental completion (it shows up as
    // "Antrenman · 0 egzersiz · 0:00 dk · 0 kcal"). Keep anything with real
    // duration or that points at actual workout content. Reused by totals + list
    // so the stat tiles and the rows stay consistent.
    const MEANINGFUL =
      '(ws.duration_sec > 0 OR ws.template_id IS NOT NULL OR ws.plan_day_id IS NOT NULL)';

    const [totRows] = await pool.execute(
      `SELECT COUNT(*) AS workouts,
              COALESCE(SUM(duration_sec),0) AS total_sec,
              COALESCE(SUM(calories_kcal),0) AS total_kcal,
              COALESCE(SUM(minutes_from_dur),0) AS total_min
         FROM (
           SELECT duration_sec, calories_kcal,
                  ROUND(COALESCE(duration_sec,0)/60) AS minutes_from_dur
             FROM workout_sessions ws
            WHERE user_id=? AND completed_at IS NOT NULL AND ${MEANINGFUL}
         ) s`,
      [userId],
    );
    const tot = totRows[0] || {};

    const [rows] = await pool.execute(
      `SELECT ws.id, ws.completed_at, ws.duration_sec, ws.calories_kcal,
              ws.exercises_total,
              ws.template_id, ws.plan_day_id, ws.plan_id,
              t.title_en AS t_en, t.title_tr AS t_tr, t.slug AS t_slug,
              t.thumbnail_path AS t_thumb,
              pd.title AS day_title, p.title AS plan_title,
              COALESCE(NULLIF(ws.exercises_total,0),
                (SELECT COUNT(*) FROM workout_template_exercises wte WHERE wte.template_id=ws.template_id),
                (SELECT COUNT(*) FROM user_plan_day_exercises pde WHERE pde.day_id=ws.plan_day_id),
                0) AS exercise_count
         FROM workout_sessions ws
         LEFT JOIN workout_templates t ON t.id = ws.template_id
         LEFT JOIN user_plan_days pd ON pd.id = ws.plan_day_id
         LEFT JOIN user_plans p ON p.id = ws.plan_id
        WHERE ws.user_id=? AND ws.completed_at IS NOT NULL AND ${MEANINGFUL}
        ORDER BY ws.completed_at DESC
        LIMIT 50`,
      [userId],
    );

    // Per-session image source: first exercise of the template or plan day.
    const tplIds = [...new Set(rows.filter((r) => r.template_id).map((r) => r.template_id))];
    const dayIds = [...new Set(
      rows.filter((r) => !r.template_id && r.plan_day_id).map((r) => r.plan_day_id),
    )];
    const [tplFirst, dayFirst] = await Promise.all([
      loadFirstExercise('workout_template_exercises', 'template_id', tplIds),
      loadFirstExercise('user_plan_day_exercises', 'day_id', dayIds),
    ]);

    const sessions = rows.map((r) => {
      const durSec = Number(r.duration_sec) || 0;
      let kcal = r.calories_kcal != null ? Number(r.calories_kcal) : 0;
      if (kcal === 0) kcal = Math.round((durSec / 60) * 7);
      const firstEx = r.template_id
        ? tplFirst.get(r.template_id)
        : (r.plan_day_id ? dayFirst.get(r.plan_day_id) : null);
      return {
        id: r.id,
        completedAt: r.completed_at, // 'YYYY-MM-DD HH:MM:SS' (dateStrings)
        titleEn: r.t_en || r.day_title || r.plan_title || null,
        titleTr: r.t_tr || r.day_title || r.plan_title || null,
        templateSlug: r.t_slug || null,
        exerciseCount: Number(r.exercise_count) || 0,
        durationSec: durSec,
        calories: kcal,
        // Prefer the template thumbnail; for plan sessions (and templates with
        // no thumbnail) fall back to the first exercise's real poster.
        thumbnailUrl:
            thumbUrl(r.t_thumb) || (firstEx ? firstEx.thumbnailUrl : null),
        // First exercise → lets the client render the user's gendered demo
        // photo (or the video poster frame) when the template thumb is NULL.
        exerciseSlug: firstEx ? firstEx.slug : null,
        exerciseVideoUrl: firstEx ? firstEx.videoUrl : null,
        // Primary muscle of the session's first exercise → the client picks the
        // matching 3D focus emoji (Figma 2516:2232 row thumbnail). NULL for an
        // empty/exercise-less session → client falls back to the full-body emoji.
        primaryMuscle: firstEx ? firstEx.primaryMuscle : null,
      };
    });

    res.json({
      success: true,
      data: {
        totals: {
          totalMinutes: Number(tot.total_min) || 0,
          totalWorkouts: Number(tot.workouts) || 0,
          totalCalories: Number(tot.total_kcal) || 0,
        },
        sessions,
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

// ── Single session detail (Workout Summary, Figma 2516:2410) ────────────────

async function getSessionDetail(req, res, next) {
  try {
    const userId = req.userId;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError('Invalid session id', 400);
    }

    const [sRows] = await pool.execute(
      `SELECT ws.id, ws.completed_at, ws.duration_sec, ws.calories_kcal,
              ws.exercises_total, ws.template_id, ws.plan_day_id, ws.plan_id,
              t.title_en AS t_en, t.title_tr AS t_tr, t.slug AS t_slug,
              t.level AS t_level, t.duration_min AS t_dur,
              pd.title AS day_title, p.title AS plan_title,
              p.level AS p_level, p.duration_min AS p_dur, p.equipment_enabled AS p_equip
         FROM workout_sessions ws
         LEFT JOIN workout_templates t ON t.id = ws.template_id
         LEFT JOIN user_plan_days pd ON pd.id = ws.plan_day_id
         LEFT JOIN user_plans p ON p.id = ws.plan_id
        WHERE ws.id=? AND ws.user_id=? LIMIT 1`,
      [id, userId],
    );
    const s = sRows[0];
    if (!s) throw new AppError('Session not found', 404);

    // Exercises performed — from the template or the plan day.
    let moveRows = [];
    if (s.template_id) {
      const [r] = await pool.execute(
        `SELECT e.slug, e.name_en, e.name_tr, e.primary_muscle, e.secondary_muscles,
                e.unit, e.thumbnail_path, e.video_cdn_path,
                wte.sets, wte.reps, wte.hold_seconds, wte.position
           FROM workout_template_exercises wte
           JOIN exercises e ON e.id = wte.exercise_id
          WHERE wte.template_id=? ORDER BY wte.position`,
        [s.template_id],
      );
      moveRows = r;
    } else if (s.plan_day_id) {
      const [r] = await pool.execute(
        `SELECT e.slug, e.name_en, e.name_tr, e.primary_muscle, e.secondary_muscles,
                e.unit, e.thumbnail_path, e.video_cdn_path,
                pde.sets, pde.reps, pde.hold_seconds, pde.position
           FROM user_plan_day_exercises pde
           JOIN exercises e ON e.id = pde.exercise_id
          WHERE pde.day_id=? ORDER BY pde.position`,
        [s.plan_day_id],
      );
      moveRows = r;
    }

    const moves = moveRows.map((m) => {
      let secondary = [];
      if (m.secondary_muscles) {
        try {
          const parsed = typeof m.secondary_muscles === 'string'
            ? JSON.parse(m.secondary_muscles)
            : m.secondary_muscles;
          if (Array.isArray(parsed)) secondary = parsed.map(String);
        } catch (_) {/* ignore */}
      }
      return {
        slug: m.slug,
        nameEn: m.name_en,
        nameTr: m.name_tr,
        primaryMuscle: m.primary_muscle || null,
        secondaryMuscles: secondary,
        unit: m.unit, // 'reps' | 'seconds'
        sets: Number(m.sets) || 0,
        reps: m.reps != null ? Number(m.reps) : null,
        holdSeconds: m.hold_seconds != null ? Number(m.hold_seconds) : null,
        // Real per-exercise poster so the summary's move rows render the
        // workout's photo (gendered demo → this thumbnail → neutral icon).
        thumbnailUrl:
            thumbUrl(m.thumbnail_path) ||
            thumbUrl(deriveThumbnailPath(m.video_cdn_path)),
        done: true,
      };
    });

    // Muscle focus + volume — derived entirely from the session's exercises.
    // Every set directly trains its exercise's primary muscle (direct volume) and
    // also indirectly stimulates each listed secondary muscle (indirect volume),
    // so both the focus chart and the volume split reflect what was actually done.
    const muscleMap = new Map(); // focus slug -> weighted set count
    let totalSets = 0;
    let directSets = 0; // sets attributed to a primary muscle
    let indirectSets = 0; // set-instances attributed to secondary muscles
    let kgMoved = 0;
    const userWeight = 70; // default estimate for the "shareable win"
    const addFocus = (muscle, sets) => {
      const focus = muscleToFocus(muscle);
      if (!focus) return;
      muscleMap.set(focus, (muscleMap.get(focus) || 0) + sets);
    };
    for (const m of moves) {
      totalSets += m.sets;
      if (m.primaryMuscle) {
        addFocus(m.primaryMuscle, m.sets);
        directSets += m.sets;
      }
      for (const sec of m.secondaryMuscles) {
        if (!sec) continue;
        addFocus(sec, m.sets * 0.5); // secondary muscles get half-credit
        indirectSets += m.sets;
      }
      // reps-equivalent for kg-moved estimate (a hold ≈ ~one rep per 3s).
      const repsEquiv = m.unit === 'seconds'
        ? Math.max(1, Math.round((m.holdSeconds || 0) / 3))
        : (m.reps || 0);
      // ~8% of bodyweight effectively "moved" per rep — lands a typical
      // bodyweight session in the playful car/animal comparison range.
      kgMoved += m.sets * repsEquiv * userWeight * 0.08;
    }
    const muscleFocus = [...muscleMap.entries()]
      .map(([muscle, sets]) => ({ muscle, sets: Math.round(sets) }))
      .filter((f) => f.sets > 0)
      .sort((a, b) => b.sets - a.sets);

    const durSec = Number(s.duration_sec) || 0;
    let kcal = s.calories_kcal != null ? Number(s.calories_kcal) : 0;
    if (kcal === 0) kcal = Math.round((durSec / 60) * 7);

    res.json({
      success: true,
      data: {
        id: s.id,
        completedAt: s.completed_at,
        // Identity of the workout that was performed, so the client can
        // re-launch the exact same session ("Do again") and label it correctly.
        templateId: s.template_id || null,
        planDayId: s.plan_day_id || null,
        planId: s.plan_id || null,
        titleEn: s.t_en || s.day_title || s.plan_title || null,
        titleTr: s.t_tr || s.day_title || s.plan_title || null,
        templateSlug: s.t_slug || null,
        durationSec: durSec,
        exerciseCount: moves.length || Number(s.exercises_total) || 0,
        calories: kcal,
        level: s.t_level || s.p_level || 'beginner',
        durationMin: Number(s.t_dur || s.p_dur) || Math.round(durSec / 60),
        equipment: Boolean(s.p_equip),
        moves,
        muscleFocus,
        volume: { totalSets, directSets, indirectSets },
        kgMoved: Math.round(kgMoved),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listDays,
  upsertDay,
  getSummary,
  getStreak,
  getStats,
  getHistory,
  getSessionDetail,
  getActiveSession,
  saveActiveSession,
  clearActiveSession,
};
