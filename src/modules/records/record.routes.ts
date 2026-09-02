import { Router } from 'express';
import multer from 'multer';
import {
  requireWorkspaceAdmin,
  requireWorkspaceEditor,
  requireWorkspaceMember,
} from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './record.controller.js';

const router = Router({ mergeParams: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 50 } });

router.route('/:resourceType')
  .get(requireWorkspaceMember, controller.list)
  .post(requireWorkspaceEditor, controller.create)
  .all(methodNotAllowed);

router.route('/:resourceType/upload')
  .post(requireWorkspaceEditor, upload.array('files', 50), controller.upload)
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
