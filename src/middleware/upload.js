const multer = require('multer');
const AppError = require('../utils/appError');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const memoryStorage = multer.memoryStorage();

const imageUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter(req, file, cb) {
    if (!allowedMimeTypes.has(file.mimetype)) {
      cb(new AppError('Unsupported file type', 415));
      return;
    }
    cb(null, true);
  },
});

module.exports = {
  imageUpload,
};
