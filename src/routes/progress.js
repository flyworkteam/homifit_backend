const express = require('express');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/progressController');

const router = express.Router();

router.get('/days', requireAuth, controller.listDays);
router.put('/days/:day', requireAuth, controller.upsertDay);
router.get('/active-session', requireAuth, controller.getActiveSession);
router.put('/active-session', requireAuth, controller.saveActiveSession);
router.delete('/active-session', requireAuth, controller.clearActiveSession);
router.get('/summary', requireAuth, controller.getSummary);
router.get('/stats', requireAuth, controller.getStats);
router.get('/history', requireAuth, controller.getHistory);
router.get('/sessions/:id', requireAuth, controller.getSessionDetail);
router.get('/streak', requireAuth, controller.getStreak);

module.exports = router;
