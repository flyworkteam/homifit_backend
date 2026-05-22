const express = require('express');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/notificationController');

const router = express.Router();

router.get('/preferences', requireAuth, controller.getPreferences);
router.put('/preferences', requireAuth, controller.updatePreferences);

// Bildirim metinleri (locale ile rotation listesi)
router.get('/messages', requireAuth, controller.listMessages);

// Sıradaki rotation seçimi (debug/preview)
router.get('/next', requireAuth, controller.previewNext);

// Manuel push tetikleme — playerIds gövdeden ya da DB'den.
// frequency_hours cooldown'u uygular, body.force=true ile override.
router.post('/send', requireAuth, controller.sendNow);

// OneSignal device subscription yönetimi
router.post('/devices/register', requireAuth, controller.registerDevice);
router.post('/devices/unregister', requireAuth, controller.unregisterDevice);

// In-app inbox
router.get('/inbox', requireAuth, controller.listInbox);
router.put('/inbox/:id/read', requireAuth, controller.markInboxRead);
router.delete('/inbox', requireAuth, controller.clearInbox);

module.exports = router;
