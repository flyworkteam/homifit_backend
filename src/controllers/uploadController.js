const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AppError = require('../utils/appError');
const { pool } = require('../config/db');

const UPLOAD_ROOT = path.resolve(__dirname, '..', '..', 'uploads');
const AVATAR_DIR = path.join(UPLOAD_ROOT, 'avatars');

function ensureDirs() {
  if (!fs.existsSync(AVATAR_DIR)) {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
  }
}

function extFromMime(mime) {
  switch (String(mime || '').toLowerCase()) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    default:
      return '.bin';
  }
}

async function uploadAvatar(req, res, next) {
  try {
    const file = req.file;
    if (!file || !file.buffer) {
      throw new AppError('No file uploaded', 400);
    }
    ensureDirs();

    const ext = extFromMime(file.mimetype);
    const filename = `u${req.userId}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const fullPath = path.join(AVATAR_DIR, filename);
    await fs.promises.writeFile(fullPath, file.buffer);

    // Public URL — served by `app.use('/uploads', express.static(...))`.
    const publicUrl = `/uploads/avatars/${filename}`;

    // Persist on user row.
    await pool.execute(
      'UPDATE users SET photo_url = ? WHERE id = ?',
      [publicUrl, req.userId],
    );

    res.json({
      success: true,
      data: { photoUrl: publicUrl, filename, sizeBytes: file.size },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  uploadAvatar,
};
