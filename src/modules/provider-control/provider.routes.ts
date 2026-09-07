import { Router } from 'express';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import { requireWorkspaceAdmin, requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import * as controller from './provider.controller.js';

export const workspaceProviderRoutes = Router({ mergeParams: true });

workspaceProviderRoutes.route('/catalog')
  .get(requireWorkspaceMember, controller.catalog)
  .all(methodNotAllowed);

workspaceProviderRoutes.route('/')
  .get(requireWorkspaceMember, controller.list)
  .all(methodNotAllowed);

workspaceProviderRoutes.route('/mappings')
  .get(requireWorkspaceMember, controller.listMappings)
  .post(requireWorkspaceAdmin, controller.createMapping)
  .all(methodNotAllowed);

workspaceProviderRoutes.route('/:connectionId')
  .get(requireWorkspaceMember, controller.detail)
  .delete(requireWorkspaceAdmin, controller.disconnect)
  .all(methodNotAllowed);

workspaceProviderRoutes.route('/:connectionId/verify')
  .post(requireWorkspaceAdmin, controller.verify)
  .all(methodNotAllowed);

workspaceProviderRoutes.route('/:connectionId/mode')
  .patch(requireWorkspaceAdmin, controller.changeMode)
  .all(methodNotAllowed);

workspaceProviderRoutes.route('/:connectionId/sync')
  .post(requireWorkspaceAdmin, controller.sync)
  .all(methodNotAllowed);

export const providerWebhookRoutes = Router();
providerWebhookRoutes.route('/:provider')
  .post(controller.webhook)
  .all(methodNotAllowed);

