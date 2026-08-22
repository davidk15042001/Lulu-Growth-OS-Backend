import { Router } from 'express';
import {
  requireOnboardingComplete,
  requireWorkspaceAdmin,
  requireWorkspaceEditor,
  requireWorkspaceMember,
} from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './workspace-app.controller.js';

const router = Router({ mergeParams: true });

router.route('/bootstrap')
  .get(requireWorkspaceMember, requireOnboardingComplete, controller.bootstrap)
  .all(methodNotAllowed);

router.route('/members')
  .get(requireWorkspaceMember, controller.members)
  .post(requireWorkspaceAdmin, controller.invite)
  .all(methodNotAllowed);

router.route('/members/:memberId')
  .patch(requireWorkspaceAdmin, controller.updateMember)
  .delete(requireWorkspaceAdmin, controller.removeMember)
  .all(methodNotAllowed);

router.route('/saved-views')
  .get(requireWorkspaceMember, controller.savedViews)
  .post(requireWorkspaceEditor, controller.createSavedView)
  .all(methodNotAllowed);

router.route('/saved-views/:viewId')
  .patch(requireWorkspaceEditor, controller.updateSavedView)
  .delete(requireWorkspaceEditor, controller.deleteSavedView)
  .all(methodNotAllowed);

router.route('/audit')
  .get(requireWorkspaceAdmin, controller.audit)
  .all(methodNotAllowed);

router.route('/billing')
  .get(requireWorkspaceAdmin, controller.billing)
  .post(requireWorkspaceAdmin, controller.createBillingCheckout)
  .all(methodNotAllowed);

router.route('/billing/checkouts/:checkoutId/sync')
  .post(requireWorkspaceAdmin, controller.syncBillingCheckout)
  .all(methodNotAllowed);

router.route('/integrations/:platformId/sync')
  .post(requireWorkspaceEditor, controller.syncIntegration)
  .all(methodNotAllowed);

router.route('/content-refresh')
  .post(requireWorkspaceEditor, controller.startContentRefresh)
  .all(methodNotAllowed);

router.route('/content-refresh/:jobId')
  .get(requireWorkspaceMember, controller.contentRefreshStatus)
  .all(methodNotAllowed);

router.route('/content-assets')
  .get(requireWorkspaceMember, controller.contentAssets)
  .all(methodNotAllowed);

export default router;
