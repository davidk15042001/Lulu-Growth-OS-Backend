import { Router } from 'express';
import { requireWorkspaceEditor, requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './agent.controller.js';

const router = Router({ mergeParams: true });
router.route('/knowledge')
  .get(requireWorkspaceMember, controller.knowledge)
  .all(methodNotAllowed);
router.route('/')
  .get(requireWorkspaceMember, controller.list)
  .post(requireWorkspaceEditor, controller.create)
  .all(methodNotAllowed);
router.route('/:runId')
  .get(requireWorkspaceMember, controller.detail)
  .all(methodNotAllowed);
router.route('/:runId/cancel')
  .post(requireWorkspaceEditor, controller.cancel)
  .all(methodNotAllowed);
router.route('/:runId/steps/:stepId/approve')
  .post(requireWorkspaceEditor, controller.approve)
  .all(methodNotAllowed);
export default router;
