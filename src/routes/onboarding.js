const express = require('express');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/onboardingController');

const router = express.Router();

router.get('/answers', requireAuth, controller.getAnswers);
router.put('/answers', requireAuth, controller.upsertAnswers);
router.delete('/answers/:questionKey', requireAuth, controller.deleteAnswer);

module.exports = router;
