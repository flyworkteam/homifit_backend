const AppError = require('../utils/appError');
const { pool } = require('../config/db');

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

    res.json({
      success: true,
      data: {
        last7Days:  { workouts: weekRows[0].workouts,  minutes: weekRows[0].minutes },
        last30Days: { workouts: monthRows[0].workouts, minutes: monthRows[0].minutes },
        allTime:    { workouts: allRows[0].workouts,   minutes: allRows[0].minutes },
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

module.exports = {
  listDays,
  upsertDay,
  getSummary,
  getStreak,
};
