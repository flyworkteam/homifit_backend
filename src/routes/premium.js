const express = require('express');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/premiumController');

const router = express.Router();

router.get('/status', requireAuth, controller.getStatus);
router.get('/pricing', requireAuth, controller.getPricing);
// Backend-managed 1-day free trial (spec: "HomiFit ilk kez indirildiğinde
// kullanıcıya sınırlı ücretsiz kullanım hakkı tanımlanır. (1 gün)").
// Idempotent / one-shot per user — see controller for semantics.
router.post('/start-trial', requireAuth, controller.startTrial);
router.post('/webhook', controller.revenueCatWebhook);

module.exports = router;
