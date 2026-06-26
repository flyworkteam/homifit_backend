const express = require('express');
const { requireAuth, loadPremium } = require('../middleware/auth');
const controller = require('../controllers/planController');

const router = express.Router();

router.get('/', requireAuth, controller.listPlans);
router.post('/generate', requireAuth, controller.generatePlanPreview);
// `loadPremium` populates req.premium so createPlan can enforce the
// free-tier caps (no `advanced` level, max 5 active plans). It's a single
// indexed SELECT and runs only on plan creation, so the perf cost is nil.
router.post('/', requireAuth, loadPremium, controller.createPlan);
router.get('/:id', requireAuth, controller.getPlan);
router.put('/:id/rename', requireAuth, controller.renamePlan);
router.post('/:id/activate', requireAuth, controller.activatePlan);
router.post('/:id/archive', requireAuth, controller.archivePlan);
router.delete('/:id', requireAuth, controller.deletePlan);

module.exports = router;
