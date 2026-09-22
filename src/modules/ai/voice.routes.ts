import { Router } from 'express';
import { requireWorkspaceEditor, requireWorkspaceEntitlement } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './voice.controller.js';

const router = Router({ mergeParams: true });

router.route('/sessions')
  .post(requireWorkspaceEditor, requireWorkspaceEntitlement('ai.enabled'), controller.createSession)
  .all(methodNotAllowed);

router.route('/sessions/:sessionId/transcripts')
  .get(requireWorkspaceEditor, requireWorkspaceEntitlement('ai.enabled'), controller.getTranscripts)
  .post(requireWorkspaceEditor, requireWorkspaceEntitlement('ai.enabled'), controller.addTranscript)
  .all(methodNotAllowed);

router.route('/sessions/:sessionId')
  .get(requireWorkspaceEditor, requireWorkspaceEntitlement('ai.enabled'), controller.getSession)
  .delete(requireWorkspaceEditor, requireWorkspaceEntitlement('ai.enabled'), controller.deleteSession)
  .all(methodNotAllowed);

router.route('/sessions/:sessionId/close')
  .post(requireWorkspaceEditor, requireWorkspaceEntitlement('ai.enabled'), controller.closeSession)
  .all(methodNotAllowed);

router.route('/speech')
  .post(requireWorkspaceEditor, requireWorkspaceEntitlement('ai.enabled'), controller.speech)
  .all(methodNotAllowed);

export default router;
