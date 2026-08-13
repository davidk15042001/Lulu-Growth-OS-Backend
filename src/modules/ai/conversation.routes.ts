import { Router } from 'express';
import { requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './conversation.controller.js';

const router = Router({ mergeParams: true });

router.use(requireWorkspaceMember);

router.route('/conversations')
  .get(controller.list)
  .post(controller.create)
  .all(methodNotAllowed);

router.route('/conversations/:conversationId')
  .get(controller.get)
  .patch(controller.update)
  .delete(controller.archive)
  .all(methodNotAllowed);

router.route('/conversations/:conversationId/messages')
  .get(controller.listMessages)
  .post(controller.createMessage)
  .all(methodNotAllowed);

router.route('/conversations/:conversationId/respond')
  .post(controller.respond)
  .all(methodNotAllowed);

export default router;
