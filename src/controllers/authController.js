const crypto = require('node:crypto');
const AppError = require('../utils/appError');
const { pool } = require('../config/db');
const firebase = require('../config/firebaseAdmin');
const { signUserToken } = require('../utils/jwt');

const REFRESH_TOKEN_BYTES = 48;
const REFRESH_TOKEN_TTL_DAYS = 60;

function hashRefresh(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newRefreshToken() {
  return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    firebaseUid: row.firebase_uid,
    email: row.email,
    displayName: row.display_name,
    photoUrl: row.photo_url,
    locale: row.locale,
    timezone: row.timezone,
    guest: Boolean(row.guest),
    isActive: Boolean(row.is_active),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

async function upsertUserByFirebase(decoded, body) {
  const firebaseUid = decoded.uid;
  const email = decoded.email || body.email || null;
  const displayName = decoded.name || body.displayName || null;
  const photoUrl = decoded.picture || body.photoUrl || null;
  const locale = String(body.locale || 'en').slice(0, 8);
  const timezone = body.timezone ? String(body.timezone).slice(0, 64) : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.execute(
      'SELECT * FROM users WHERE firebase_uid = ? LIMIT 1',
      [firebaseUid],
    );

    let user;
    if (existing.length > 0) {
      const found = existing[0];
      await conn.execute(
        `UPDATE users
         SET email = COALESCE(?, email),
             display_name = COALESCE(?, display_name),
             photo_url = COALESCE(?, photo_url),
             locale = ?,
             timezone = COALESCE(?, timezone),
             guest = 0,
             is_active = 1,
             last_login_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [email, displayName, photoUrl, locale, timezone, found.id],
      );
      const [refreshed] = await conn.execute(
        'SELECT * FROM users WHERE id = ?',
        [found.id],
      );
      user = refreshed[0];
    } else {
      const [insert] = await conn.execute(
        `INSERT INTO users
           (firebase_uid, email, display_name, photo_url, locale, timezone, guest, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`,
        [firebaseUid, email, displayName, photoUrl, locale, timezone],
      );
      const [created] = await conn.execute(
        'SELECT * FROM users WHERE id = ?',
        [insert.insertId],
      );
      user = created[0];

      // Seed dependent rows so downstream queries don't need null-checks.
      await conn.execute('INSERT INTO user_profile (user_id) VALUES (?)', [user.id]);
      await conn.execute(
        'INSERT INTO user_notification_prefs (user_id, locale) VALUES (?, ?)',
        [user.id, locale],
      );
      await conn.execute('INSERT INTO user_streak_counters (user_id) VALUES (?)', [user.id]);
    }

    await conn.commit();
    return user;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function issueRefreshToken(userId, req) {
  const token = newRefreshToken();
  const hash = hashRefresh(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await pool.execute(
    `INSERT INTO user_refresh_tokens
       (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      userId,
      hash,
      String(req.headers['user-agent'] || '').slice(0, 255) || null,
      String(req.ip || '').slice(0, 45) || null,
      expiresAt,
    ],
  );
  return { token, expiresAt };
}

async function signInWithFirebase(req, res, next) {
  try {
    const body = req.body || {};
    const idToken = String(body.idToken || '').trim();
    if (!idToken) {
      throw new AppError('idToken is required', 400);
    }

    let decoded;
    try {
      decoded = await firebase.verifyIdToken(idToken);
    } catch (error) {
      throw new AppError('Invalid Firebase ID token', 401);
    }

    const user = await upsertUserByFirebase(decoded, body);
    const accessToken = signUserToken({
      userId: user.id,
      sub: String(user.id),
      firebase_uid: user.firebase_uid,
    });
    const refresh = await issueRefreshToken(user.id, req);

    res.json({
      success: true,
      data: {
        token: accessToken,
        refreshToken: refresh.token,
        refreshExpiresAt: refresh.expiresAt.toISOString(),
        user: rowToUser(user),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function refreshToken(req, res, next) {
  try {
    const body = req.body || {};
    const incoming = String(body.refreshToken || '').trim();
    if (!incoming) {
      throw new AppError('refreshToken is required', 400);
    }
    const hash = hashRefresh(incoming);

    const [rows] = await pool.execute(
      `SELECT t.*, u.firebase_uid
         FROM user_refresh_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ?
        LIMIT 1`,
      [hash],
    );
    if (rows.length === 0) {
      throw new AppError('Invalid refresh token', 401);
    }
    const row = rows[0];
    if (row.revoked_at) {
      throw new AppError('Refresh token revoked', 401);
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new AppError('Refresh token expired', 401);
    }

    // Rotate: revoke old, issue new.
    await pool.execute(
      'UPDATE user_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?',
      [row.id],
    );
    const accessToken = signUserToken({
      userId: row.user_id,
      sub: String(row.user_id),
      firebase_uid: row.firebase_uid,
    });
    const fresh = await issueRefreshToken(row.user_id, req);

    res.json({
      success: true,
      data: {
        token: accessToken,
        refreshToken: fresh.token,
        refreshExpiresAt: fresh.expiresAt.toISOString(),
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

async function logout(req, res, next) {
  try {
    const body = req.body || {};
    const incoming = String(body.refreshToken || '').trim();
    if (incoming) {
      const hash = hashRefresh(incoming);
      await pool.execute(
        'UPDATE user_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL',
        [hash],
      );
    }
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  signInWithFirebase,
  refreshToken,
  logout,
};
