import { Router } from 'express';
import { requireWorkspaceEditor, requireWorkspaceEntitlement, requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './conversation.controller.js';
import voiceRoutes from './voice.routes.js';

const router = Router({ mergeParams: true });

router.use(requireWorkspaceMember);
router.use('/voice', voiceRoutes);

router.route('/conversations')
  .get(controller.list)
  .post(requireWorkspaceEditor, requireWorkspaceEntitlement('ai.enabled'), controller.create)
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
  .post(requireWorkspaceEditor, requireWorkspaceEntitlement('ai.enabled'), controller.respond)
  .all(methodNotAllowed);

router.route('/conversations/:conversationId/actions')
  .get(requireWorkspaceEntitlement('ai.enabled'), controller.listActions)
  .post(requireWorkspaceEditor, requireWorkspaceEntitlement('ai.enabled'), controller.executeAction)
  .all(methodNotAllowed);

router.route('/conversations/:conversationId/export')
  .get(controller.exportConversation)
  .all(methodNotAllowed);

router.route('/conversations/:conversationId/actions/:actionId/cancel')
  .post(requireWorkspaceEditor, requireWorkspaceEntitlement('ai.enabled'), controller.cancelAction)
  .all(methodNotAllowed);

export default router;
