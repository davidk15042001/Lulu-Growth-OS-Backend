import { Router } from 'express';
import { requireWorkspaceMember } from '../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../middlewares/methodNotAllowed.middleware.js';
import { streamWorkspaceEvents } from './workspace-event.controller.js';

const router = Router({ mergeParams: true });

router.route('/stream')
  .get(requireWorkspaceMember, streamWorkspaceEvents)
  .all(methodNotAllowed);

export default router;
