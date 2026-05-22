const express = require('express');
const controller = require('../controllers/authController');

const router = express.Router();

// POST /api/auth/firebase  — exchange a Firebase ID token for a backend JWT
router.post('/firebase', controller.signInWithFirebase);

// POST /api/auth/guest     — create / reuse a UUID-based guest account when
//                            Firebase Anonymous Auth isn't enabled.
router.post('/guest', controller.signInAsGuest);

// POST /api/auth/refresh   — refresh an existing JWT
router.post('/refresh', controller.refreshToken);

// POST /api/auth/logout
router.post('/logout', controller.logout);

module.exports = router;
