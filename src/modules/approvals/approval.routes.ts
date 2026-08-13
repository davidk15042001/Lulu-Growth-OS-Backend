import { Router } from 'express';
import {
  requireWorkspaceEditor,
  requireWorkspaceMember,
} from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './approval.controller.js';

const router = Router({ mergeParams: true });

router.route('/')
  .get(requireWorkspaceMember, controller.list)
  .post(requireWorkspaceEditor, controller.create)
  .all(methodNotAllowed);

router.route('/:approvalId/decision')
  .post(requireWorkspaceEditor, controller.decide)
  .all(methodNotAllowed);

export default router;
