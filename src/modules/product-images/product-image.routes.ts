import { Router } from 'express';
import multer from 'multer';
import { requireWorkspaceEditor, requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './product-image.controller.js';

const router = Router({ mergeParams: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

router.route('/generate')
  .post(requireWorkspaceEditor, upload.single('file'), controller.generate)
  .all(methodNotAllowed);

router.route('/:imageId/image')
  .get(requireWorkspaceMember, controller.image)
  .all(methodNotAllowed);

export default router;
