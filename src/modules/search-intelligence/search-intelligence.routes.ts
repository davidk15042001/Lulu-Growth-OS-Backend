import { Router } from 'express';
import { requireWorkspaceEditor, requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './search-intelligence.controller.js';

const router = Router({ mergeParams: true });

router.use(requireWorkspaceMember);

router.route('/:channel')
  .get(controller.summary)
  .all(methodNotAllowed);

router.route('/:channel/analyze')
  .post(requireWorkspaceEditor, controller.analyze)
  .all(methodNotAllowed);

router.route('/:channel/apply')
  .post(requireWorkspaceEditor, controller.apply)
  .all(methodNotAllowed);

export default router;
