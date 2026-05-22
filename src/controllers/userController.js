const AppError = require('../utils/appError');
const { pool } = require('../config/db');

const PROFILE_ENUMS = {
  identity: new Set(['woman', 'man', 'non_binary', 'prefer_not']),
  body_type: new Set(['average', 'lean', 'athletic', 'heavy']),
  primary_goal: new Set(['lose_weight', 'build_muscle', 'stay_fit', 'boost_energy']),
  level: new Set(['beginner', 'intermediate', 'advanced']),
};

const FOCUS_AREAS = new Set([
  'arms', 'shoulders', 'chest', 'back', 'core', 'legs', 'glutes', 'full_body',
]);

function rowToUser(u) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    photoUrl: u.photo_url,
    locale: u.locale,
    timezone: u.timezone,
    guest: Boolean(u.guest),
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

function rowToProfile(p) {
  if (!p) return null;
  return {
    identity: p.identity,
    bodyType: p.body_type,
    heightCm: p.height_cm,
    weightKg: p.weight_kg,
    birthYear: p.birth_year,
    primaryGoal: p.primary_goal,
    level: p.level,
    durationMin: p.duration_min,
    daysPerWeek: p.days_per_week,
    warmupEnabled: Boolean(p.warmup_enabled),
    stretchingEnabled: Boolean(p.stretching_enabled),
    equipmentEnabled: Boolean(p.equipment_enabled),
    focusAreas: p.focus_areas
      ? (typeof p.focus_areas === 'string' ? JSON.parse(p.focus_areas) : p.focus_areas)
      : [],
    onboardingCompletedAt: p.onboarding_completed_at,
  };
}

async function getProfile(req, res, next) {
  try {
    const [users] = await pool.execute(
      'SELECT * FROM users WHERE id = ? LIMIT 1',
      [req.userId],
    );
    if (users.length === 0) throw new AppError('User not found', 404);

    const [profiles] = await pool.execute(
      'SELECT * FROM user_profile WHERE user_id = ? LIMIT 1',
      [req.userId],
    );

    res.json({
      success: true,
      data: {
        user: rowToUser(users[0]),
        profile: rowToProfile(profiles[0] || null),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function updateProfile(req, res, next) {
  try {
    const body = req.body || {};
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // ── users table fields ─────────────────────────────────────────
      const userPatch = [];
      const userParams = [];
      if (typeof body.displayName === 'string') {
        userPatch.push('display_name = ?');
        userParams.push(body.displayName.slice(0, 120) || null);
      }
      if (typeof body.locale === 'string') {
        userPatch.push('locale = ?');
        userParams.push(body.locale.slice(0, 8));
      }
      if (typeof body.timezone === 'string') {
        userPatch.push('timezone = ?');
        userParams.push(body.timezone.slice(0, 64));
      }
      if (typeof body.photoUrl === 'string') {
        userPatch.push('photo_url = ?');
        userParams.push(body.photoUrl.slice(0, 512));
      }
      if (userPatch.length > 0) {
        userParams.push(req.userId);
        await conn.execute(
          `UPDATE users SET ${userPatch.join(', ')} WHERE id = ?`,
          userParams,
        );
      }

      // ── user_profile fields ────────────────────────────────────────
      const profPatch = [];
      const profParams = [];

      function pushEnum(field, key) {
        if (body[key] === null) {
          profPatch.push(`${field} = NULL`);
          return;
        }
        if (typeof body[key] !== 'string') return;
        const v = body[key];
        if (!PROFILE_ENUMS[field].has(v)) {
          throw new AppError(`Invalid ${key}: ${v}`, 400);
        }
        profPatch.push(`${field} = ?`);
        profParams.push(v);
      }

      function pushInt(field, key, min, max) {
        if (body[key] === null) {
          profPatch.push(`${field} = NULL`);
          return;
        }
        if (body[key] === undefined) return;
        const n = Number.parseInt(body[key], 10);
        if (!Number.isInteger(n) || n < min || n > max) {
          throw new AppError(`Invalid ${key}: ${body[key]}`, 400);
        }
        profPatch.push(`${field} = ?`);
        profParams.push(n);
      }

      function pushBool(field, key) {
        if (typeof body[key] !== 'boolean') return;
        profPatch.push(`${field} = ?`);
        profParams.push(body[key] ? 1 : 0);
      }

      pushEnum('identity', 'identity');
      pushEnum('body_type', 'bodyType');
      pushEnum('primary_goal', 'primaryGoal');
      pushEnum('level', 'level');
      pushInt('height_cm', 'heightCm', 80, 260);
      pushInt('weight_kg', 'weightKg', 25, 350);
      pushInt('birth_year', 'birthYear', 1900, new Date().getFullYear());
      pushInt('duration_min', 'durationMin', 5, 240);
      pushInt('days_per_week', 'daysPerWeek', 1, 7);
      pushBool('warmup_enabled', 'warmupEnabled');
      pushBool('stretching_enabled', 'stretchingEnabled');
      pushBool('equipment_enabled', 'equipmentEnabled');

      if (Array.isArray(body.focusAreas)) {
        const cleaned = body.focusAreas
          .map((v) => String(v))
          .filter((v) => FOCUS_AREAS.has(v));
        profPatch.push('focus_areas = ?');
        profParams.push(JSON.stringify(cleaned));
      }

      if (body.onboardingCompleted === true) {
        profPatch.push('onboarding_completed_at = COALESCE(onboarding_completed_at, CURRENT_TIMESTAMP)');
      }

      if (profPatch.length > 0) {
        // Ensure a row exists.
        await conn.execute(
          'INSERT IGNORE INTO user_profile (user_id) VALUES (?)',
          [req.userId],
        );
        profParams.push(req.userId);
        await conn.execute(
          `UPDATE user_profile SET ${profPatch.join(', ')} WHERE user_id = ?`,
          profParams,
        );
      }

      // Optional: append a body measurement row if weight/height changed.
      if (typeof body.weightKg === 'number' || typeof body.heightCm === 'number') {
        await conn.execute(
          `INSERT INTO body_measurements (user_id, weight_kg, height_cm, source)
           VALUES (?, ?, ?, 'manual')`,
          [
            req.userId,
            typeof body.weightKg === 'number' ? body.weightKg : null,
            typeof body.heightCm === 'number' ? body.heightCm : null,
          ],
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // Return the freshly merged shape.
    return getProfile(req, res, next);
  } catch (error) {
    next(error);
  }
}

async function deleteProfile(req, res, next) {
  try {
    // Hard delete — FK CASCADE will clean up dependent rows.
    const [result] = await pool.execute(
      'DELETE FROM users WHERE id = ?',
      [req.userId],
    );
    if (result.affectedRows === 0) {
      throw new AppError('User not found', 404);
    }
    res.json({ success: true, data: { deleted: true }, error: null });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getProfile,
  updateProfile,
  deleteProfile,
};
