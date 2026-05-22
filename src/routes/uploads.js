const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { imageUpload } = require('../middleware/upload');
const controller = require('../controllers/uploadController');

const router = express.Router();

router.post('/avatar', requireAuth, imageUpload.single('avatar'), controller.uploadAvatar);

module.exports = router;
