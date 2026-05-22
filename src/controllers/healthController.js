const AppError = require('../utils/appError');
const { pool } = require('../config/db');

async function ensureRow(userId) {
  await pool.execute(
    'INSERT IGNORE INTO health_sync_state (user_id) VALUES (?)',
    [userId],
  );
}

function rowToView(r) {
  return {
    appleHealthOn: Boolean(r.apple_health_on),
    healthConnectOn: Boolean(r.health_connect_on),
    lastSyncAt: r.last_sync_at,
  };
}

async function getStatus(req, res, next) {
  try {
    await ensureRow(req.userId);
    const [rows] = await pool.execute(
      'SELECT * FROM health_sync_state WHERE user_id = ? LIMIT 1',
      [req.userId],
    );
    res.json({
      success: true,
      data: rowToView(rows[0] || { apple_health_on: 0, health_connect_on: 0 }),
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function updateStatus(req, res, next) {
  try {
    await ensureRow(req.userId);
    const body = req.body || {};
    const fields = [];
    const params = [];
    if (typeof body.appleHealthOn === 'boolean') {
      fields.push('apple_health_on = ?');
      params.push(body.appleHealthOn ? 1 : 0);
    }
    if (typeof body.healthConnectOn === 'boolean') {
      fields.push('health_connect_on = ?');
      params.push(body.healthConnectOn ? 1 : 0);
    }
    if (body.synced === true) {
      fields.push('last_sync_at = CURRENT_TIMESTAMP');
    }
    if (fields.length === 0) {
      throw new AppError('No fields to update', 400);
    }
    params.push(req.userId);
    await pool.execute(
      `UPDATE health_sync_state SET ${fields.join(', ')} WHERE user_id = ?`,
      params,
    );
    return getStatus(req, res, next);
  } catch (error) {
    next(error);
  }
}

/// Accept a snapshot from the device — steps + active calories + workouts.
/// We just stash a progress_log row + bump last_sync_at.
async function pushSnapshot(req, res, next) {
  try {
    const body = req.body || {};
    const steps = Number.parseInt(body.steps, 10);
    const calories = Number.parseInt(body.calories, 10);
    const minutes = Number.parseInt(body.minutes, 10);

    const meta = {};
    if (Number.isFinite(steps)) meta.steps = steps;
    if (Number.isFinite(calories)) meta.calories = calories;
    if (Number.isFinite(minutes)) meta.minutes = minutes;
    if (body.source) meta.source = String(body.source).slice(0, 32);

    await pool.execute(
      `INSERT INTO progress_log (user_id, event_type, amount, meta)
       VALUES (?, 'health_snapshot', ?, ?)`,
      [
        req.userId,
        Number.isFinite(steps) ? steps : 0,
        JSON.stringify(meta),
      ],
    );
    await ensureRow(req.userId);
    await pool.execute(
      'UPDATE health_sync_state SET last_sync_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      [req.userId],
    );
    res.json({ success: true, data: { ok: true, meta }, error: null });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getStatus,
  updateStatus,
  pushSnapshot,
};
