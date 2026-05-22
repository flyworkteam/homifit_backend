const express = require('express');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/progressController');

const router = express.Router();

router.get('/days', requireAuth, controller.listDays);
router.put('/days/:day', requireAuth, controller.upsertDay);
router.get('/summary', requireAuth, controller.getSummary);
router.get('/streak', requireAuth, controller.getStreak);

module.exports = router;
