const express = require('express');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/planController');

const router = express.Router();

router.get('/', requireAuth, controller.listPlans);
router.post('/', requireAuth, controller.createPlan);
router.get('/:id', requireAuth, controller.getPlan);
router.put('/:id/rename', requireAuth, controller.renamePlan);
router.post('/:id/activate', requireAuth, controller.activatePlan);
router.post('/:id/archive', requireAuth, controller.archivePlan);
router.delete('/:id', requireAuth, controller.deletePlan);

module.exports = router;
