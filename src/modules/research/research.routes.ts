import { Router } from 'express';
import { requireWorkspaceEditor, requireWorkspaceEntitlement, requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './research.controller.js';

const router = Router({ mergeParams: true });

router.use(requireWorkspaceMember);
router.route('/perplexity/deep')
  .post(requireWorkspaceEditor, requireWorkspaceEntitlement('ai.enabled'), controller.deepResearch)
  .all(methodNotAllowed);

export default router;
