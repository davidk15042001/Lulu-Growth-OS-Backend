import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './admin.controller.js';

const router = Router();
router.route('/billing-overview').get(requireAuth, controller.overview).all(methodNotAllowed);
router.route('/workspaces/:workspaceId/plan').patch(requireAuth, controller.changePlan).all(methodNotAllowed);
export default router;
