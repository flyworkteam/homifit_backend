const express = require('express');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/videoController');

const router = express.Router();

// Public manifest reads — auth-gated so only logged-in clients can stream.
router.get('/', requireAuth, controller.listAll);
router.get('/categories', requireAuth, controller.listCategories);
router.get('/categories/:slug', requireAuth, controller.listByCategory);
router.get('/resolve', requireAuth, controller.resolveByName);

module.exports = router;
