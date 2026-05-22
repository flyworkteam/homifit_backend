const express = require('express');
const { requireAuth, loadPremium } = require('../middleware/auth');
const controller = require('../controllers/workoutController');

const router = express.Router();

router.get('/program', requireAuth, controller.getProgram);
router.get('/program/:day', requireAuth, controller.getDay);
router.get('/categories', requireAuth, controller.listCategories);
// `loadPremium` populates req.premium so list/detail handlers can attach
// `locked: true` flags to premium templates for free users. (Doesn't block
// access; only marks them — getTemplate enforces the hard gate.)
router.get('/categories/:slug', requireAuth, loadPremium, controller.getCategory);
router.get('/quick', requireAuth, loadPremium, controller.listQuickWorkouts);
router.get('/exercises', requireAuth, controller.listExercises);
router.get('/templates/:slug', requireAuth, loadPremium, controller.getTemplate);

module.exports = router;
