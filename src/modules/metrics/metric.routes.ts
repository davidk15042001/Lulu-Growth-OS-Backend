import { Router } from 'express';
import {
  requireWorkspaceAdmin,
  requireWorkspaceEditor,
  requireWorkspaceMember,
} from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './metric.controller.js';

const router = Router({ mergeParams: true });

router.route('/')
  .get(requireWorkspaceMember, controller.list)
  .post(requireWorkspaceAdmin, controller.create)
  .all(methodNotAllowed);

router.route('/:metricId')
  .get(requireWorkspaceMember, controller.get)
  .patch(requireWorkspaceAdmin, controller.update)
  .delete(requireWorkspaceAdmin, controller.archive)
  .all(methodNotAllowed);

router.route('/:metricId/points')
  .get(requireWorkspaceMember, controller.listPoints)
  .post(requireWorkspaceEditor, controller.ingestPoints)
  .all(methodNotAllowed);

export default router;
