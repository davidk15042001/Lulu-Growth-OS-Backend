import { Router } from 'express';
import { requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './notification.controller.js';

const router = Router({ mergeParams: true });

router.use(requireWorkspaceMember);

router.route('/')
  .get(controller.list)
  .all(methodNotAllowed);

router.route('/read-all')
  .post(controller.markAllRead)
  .all(methodNotAllowed);

router.route('/:notificationId/read')
  .patch(controller.markRead)
  .all(methodNotAllowed);

router.route('/:notificationId')
  .delete(controller.dismiss)
  .all(methodNotAllowed);

export default router;
