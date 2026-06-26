const express = require('express');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/premiumController');

const router = express.Router();

router.get('/status', requireAuth, controller.getStatus);
router.get('/pricing', requireAuth, controller.getPricing);
// Backend-managed 3-day free trial (spec: "HomiFit ilk kez indirildiğinde
// kullanıcıya sınırlı ücretsiz kullanım hakkı tanımlanır.").
// Idempotent / one-shot per user — see controller for semantics.
router.post('/start-trial', requireAuth, controller.startTrial);
// Instant post-purchase sync: pulls the RevenueCat subscriber state for the
// caller and upserts it, so paid content unlocks without waiting for the
// async webhook. Falls back to the webhook-written state when RC isn't keyed.
router.post('/sync', requireAuth, controller.syncFromStore);
router.post('/webhook', controller.revenueCatWebhook);

module.exports = router;
