const express = require('express');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/workoutController');

const router = express.Router();

router.get('/program', requireAuth, controller.getProgram);
router.get('/program/:day', requireAuth, controller.getDay);
router.get('/categories', requireAuth, controller.listCategories);
router.get('/categories/:slug', requireAuth, controller.getCategory);
router.get('/quick', requireAuth, controller.listQuickWorkouts);
router.get('/templates/:slug', requireAuth, controller.getTemplate);

module.exports = router;
