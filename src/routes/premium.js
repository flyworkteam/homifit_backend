const express = require('express');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/premiumController');

const router = express.Router();

router.get('/status', requireAuth, controller.getStatus);
router.post('/webhook', controller.revenueCatWebhook);

module.exports = router;
