import { Router } from 'express';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import { requireWorkspaceAdmin, requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import * as controller from './growth-approval.controller.js';

const router = Router({ mergeParams: true });
router.route('/')
  .get(requireWorkspaceMember, controller.list)
  .all(methodNotAllowed);
router.route('/:approvalId/decision')
  .post(requireWorkspaceAdmin, controller.decide)
  .all(methodNotAllowed);

export default router;
