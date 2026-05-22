const express = require('express');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/userController');

const router = express.Router();

router.get('/profile', requireAuth, controller.getProfile);
router.put('/profile', requireAuth, controller.updateProfile);
router.delete('/profile', requireAuth, controller.deleteProfile);

module.exports = router;
