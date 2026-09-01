import { Router } from 'express';
import {
  requireWorkspaceAdmin,
  requireWorkspaceEditor,
  requireWorkspaceMember,
} from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './record.controller.js';

const router = Router({ mergeParams: true });

router.route('/:resourceType')
  .get(requireWorkspaceMember, controller.list)
  .post(requireWorkspaceEditor, controller.create)
  .all(methodNotAllowed);

router.route('/:resourceType/ingest')
  .post(requireWorkspaceEditor, controller.ingest)
  .all(methodNotAllowed);

router.route('/:resourceType/:recordId')
  .get(requireWorkspaceMember, controller.get)
  .patch(requireWorkspaceEditor, controller.update)
  .delete(requireWorkspaceEditor, controller.archive)
  .all(methodNotAllowed);

router.route('/:resourceType/:recordId/restore')
  .post(requireWorkspaceAdmin, controller.restore)
  .all(methodNotAllowed);

export default router;
