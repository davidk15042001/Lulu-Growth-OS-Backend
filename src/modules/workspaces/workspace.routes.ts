import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.middleware.js';
import {
  requireWorkspaceAdmin,
  requireWorkspaceMember,
} from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './workspace.controller.js';
import onboardingRoutes from '../onboarding/onboarding.routes.js';
import recordRoutes from '../records/record.routes.js';
import metricRoutes from '../metrics/metric.routes.js';
import notificationRoutes from '../notifications/notification.routes.js';
import conversationRoutes from '../ai/conversation.routes.js';
import approvalRoutes from '../approvals/approval.routes.js';

const router = Router();

router.use(requireAuth);

router.route('/')
  .get(controller.list)
  .post(controller.create)
  .all(methodNotAllowed);

router.route('/:workspaceId')
  .get(requireWorkspaceMember, controller.get)
  .patch(requireWorkspaceAdmin, controller.update)
  .all(methodNotAllowed);

router.use('/:workspaceId/onboarding', onboardingRoutes);
router.use('/:workspaceId/records', recordRoutes);
router.use('/:workspaceId/metrics', metricRoutes);
router.use('/:workspaceId/notifications', notificationRoutes);
router.use('/:workspaceId/ai', conversationRoutes);
router.use('/:workspaceId/approvals', approvalRoutes);

export default router;
