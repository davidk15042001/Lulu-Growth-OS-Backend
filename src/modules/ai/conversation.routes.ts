import { Router } from 'express';
import { requireWorkspaceEditor, requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './conversation.controller.js';

const router = Router({ mergeParams: true });

router.use(requireWorkspaceMember);

router.route('/conversations')
  .get(controller.list)
  .post(requireWorkspaceEditor, controller.create)
  .all(methodNotAllowed);

router.route('/conversations/:conversationId')
  .get(controller.get)
  .patch(requireWorkspaceEditor, controller.update)
  .delete(requireWorkspaceEditor, controller.archive)
  .all(methodNotAllowed);

router.route('/conversations/:conversationId/messages')
  .get(controller.listMessages)
  .post(requireWorkspaceEditor, controller.createMessage)
  .all(methodNotAllowed);

router.route('/conversations/:conversationId/respond')
  .post(requireWorkspaceEditor, controller.respond)
  .all(methodNotAllowed);

router.route('/conversations/:conversationId/actions')
  .post(requireWorkspaceEditor, controller.executeAction)
  .all(methodNotAllowed);

export default router;
