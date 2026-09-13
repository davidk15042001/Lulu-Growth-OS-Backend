import { Router } from 'express';
import { requireWorkspaceAdmin, requireWorkspaceCapability, requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './adspend.controller.js';

const router = Router({ mergeParams: true });

router.route('/')
  .get(requireWorkspaceMember, controller.overview)
  .all(methodNotAllowed);

router.route('/topups')
  .post(requireWorkspaceAdmin, controller.createTopup)
  .all(methodNotAllowed);

router.route('/topups/:topupId/sync')
  .post(requireWorkspaceAdmin, controller.syncTopup)
  .all(methodNotAllowed);

router.route('/budget-authorizations')
  .get(requireWorkspaceCapability('advertising.read', { enforceWriteEntitlement: false }), controller.listBudgetAuthorizations)
  .post(requireWorkspaceCapability('advertising.budget_authorize'), controller.createBudgetAuthorization)
  .all(methodNotAllowed);

router.route('/budget-authorizations/:authorizationId/revoke')
  .post(requireWorkspaceCapability('advertising.budget_authorize'), controller.revokeBudgetAuthorization)
  .all(methodNotAllowed);

export default router;
