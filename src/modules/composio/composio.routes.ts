import { Router } from 'express';
import { requireWorkspaceEditor, requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './composio.controller.js';

const router = Router({ mergeParams: true });
router.use(requireWorkspaceMember);
router.route('/toolkits')
  .get(controller.listToolkits)
  .all(methodNotAllowed);
router.route('/authorize')
  .post(requireWorkspaceEditor, controller.authorizeToolkit)
  .all(methodNotAllowed);
router.route('/session')
  .post(requireWorkspaceEditor, controller.createSession)
  .all(methodNotAllowed);

export default router;
