const AppError = require('../utils/appError');
const { pool } = require('../config/db');

const ALLOWED_KEYS = new Set([
  'goal',
  'level',
  'duration',
  'days_per_week',
  'identity',
  'body_type',
  'height',
  'weight',
  'focus_areas',
  'warmup',
  'stretching',
  'equipment',
  'plan_name',
]);

async function getAnswers(req, res, next) {
  try {
    // Latest answer per question_key.
    const [rows] = await pool.execute(
      `SELECT a.question_key, a.answer, a.created_at
         FROM user_onboarding_answers a
         JOIN (
           SELECT question_key, MAX(created_at) AS max_at
             FROM user_onboarding_answers
            WHERE user_id = ?
            GROUP BY question_key
         ) latest
           ON latest.question_key = a.question_key
          AND latest.max_at = a.created_at
        WHERE a.user_id = ?
        ORDER BY a.question_key`,
      [req.userId, req.userId],
    );

    const map = {};
    for (const r of rows) {
      map[r.question_key] = {
        answer: typeof r.answer === 'string' ? JSON.parse(r.answer) : r.answer,
        savedAt: r.created_at,
      };
    }

    res.json({ success: true, data: { answers: map }, error: null });
  } catch (error) {
    next(error);
  }
}

async function upsertAnswers(req, res, next) {
  try {
    const body = req.body || {};
    const answers = body.answers && typeof body.answers === 'object' ? body.answers : null;
    if (!answers) {
      throw new AppError('answers object is required', 400);
    }

    const entries = Object.entries(answers).filter(([k]) => ALLOWED_KEYS.has(k));
    if (entries.length === 0) {
      throw new AppError('No valid keys in answers payload', 400);
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const [key, value] of entries) {
        await conn.execute(
          `INSERT INTO user_onboarding_answers (user_id, question_key, answer)
           VALUES (?, ?, ?)`,
          [req.userId, key, JSON.stringify(value)],
        );
      }

      // Mirror common keys into user_profile so the rest of the app can
      // read them without re-parsing the audit log.
      const updates = [];
      const params = [];
      const a = answers;
      function addEnum(field, key, allowed) {
        if (typeof a[key] === 'string' && allowed.includes(a[key])) {
          updates.push(`${field} = ?`);
          params.push(a[key]);
        }
      }
      function addInt(field, key) {
        if (typeof a[key] === 'number') {
          updates.push(`${field} = ?`);
          params.push(Math.trunc(a[key]));
        }
      }
      function addBool(field, key) {
        if (typeof a[key] === 'boolean') {
          updates.push(`${field} = ?`);
          params.push(a[key] ? 1 : 0);
        }
      }
      addEnum('primary_goal', 'goal', ['lose_weight', 'build_muscle', 'stay_fit', 'boost_energy']);
      addEnum('level', 'level', ['beginner', 'intermediate', 'advanced']);
      addInt('duration_min', 'duration');
      addInt('days_per_week', 'days_per_week');
      addEnum('identity', 'identity', ['woman', 'man', 'non_binary', 'prefer_not']);
      addEnum('body_type', 'body_type', ['average', 'lean', 'athletic', 'heavy']);
      addInt('height_cm', 'height');
      addInt('weight_kg', 'weight');
      addBool('warmup_enabled', 'warmup');
      addBool('stretching_enabled', 'stretching');
      addBool('equipment_enabled', 'equipment');

      if (Array.isArray(a.focus_areas)) {
        updates.push('focus_areas = ?');
        params.push(JSON.stringify(a.focus_areas.map(String)));
      }

      if (updates.length > 0) {
        await conn.execute(
          'INSERT IGNORE INTO user_profile (user_id) VALUES (?)',
          [req.userId],
        );
        params.push(req.userId);
        await conn.execute(
          `UPDATE user_profile SET ${updates.join(', ')} WHERE user_id = ?`,
          params,
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    return getAnswers(req, res, next);
  } catch (error) {
    next(error);
  }
}

async function deleteAnswer(req, res, next) {
  try {
    const key = String(req.params.questionKey || '').trim();
    if (!ALLOWED_KEYS.has(key)) {
      throw new AppError(`Unknown question key: ${key}`, 400);
    }
    await pool.execute(
      'DELETE FROM user_onboarding_answers WHERE user_id = ? AND question_key = ?',
      [req.userId, key],
    );
    res.json({ success: true, data: { deleted: key }, error: null });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAnswers,
  upsertAnswers,
  deleteAnswer,
};
