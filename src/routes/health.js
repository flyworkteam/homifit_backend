const express = require('express');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/healthController');

const router = express.Router();

router.get('/status', requireAuth, controller.getStatus);
router.put('/status', requireAuth, controller.updateStatus);
router.post('/snapshot', requireAuth, controller.pushSnapshot);

module.exports = router;
