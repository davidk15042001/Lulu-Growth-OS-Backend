import { Router } from 'express';
import { requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './usage.controller.js';

const router = Router({ mergeParams: true });
router.use(requireWorkspaceMember);
router.route('/credits')
  .get(controller.credits)
  .all(methodNotAllowed);

export default router;
