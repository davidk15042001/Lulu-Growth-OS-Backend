import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './admin.controller.js';

import { requireAdminCapabilities } from './admin.authorization.js';

const router = Router();

router.route('/dashboard').get(requireAuth, requireAdminCapabilities('users.read', 'workspaces.read', 'billing.read', 'providers.read', 'agents.read', 'security.read'), controller.dashboard).all(methodNotAllowed);
router.route('/search').get(requireAuth, requireAdminCapabilities('users.read', 'workspaces.read', 'providers.read'), controller.searchAll).all(methodNotAllowed);

router.route('/billing-overview').get(requireAuth, requireAdminCapabilities('billing.read'), controller.overview).all(methodNotAllowed);

router.route('/users').get(requireAuth, requireAdminCapabilities('users.read'), controller.getUsers).all(methodNotAllowed);
router.route('/users/:userId').get(requireAuth, requireAdminCapabilities('users.read', 'workspaces.read', 'billing.read'), controller.getUser).patch(requireAuth, requireAdminCapabilities('users.manage'), controller.patchUser).delete(requireAuth, requireAdminCapabilities('users.manage'), controller.deleteUser).all(methodNotAllowed);
router.route('/users/:userId/impersonate').post(requireAuth, requireAdminCapabilities('users.impersonate'), controller.impersonateUser).all(methodNotAllowed);

router.route('/workspaces').get(requireAuth, requireAdminCapabilities('workspaces.read'), controller.getWorkspaces).all(methodNotAllowed);
router.route('/workspaces/:workspaceId').get(requireAuth, requireAdminCapabilities('workspaces.read', 'billing.read'), controller.getWorkspace).patch(requireAuth, requireAdminCapabilities('workspaces.manage'), controller.patchWorkspace).all(methodNotAllowed);
router.route('/workspaces/:workspaceId/plan').patch(requireAuth, requireAdminCapabilities('billing.manage'), controller.changePlan).all(methodNotAllowed);
router.route('/workspaces/:workspaceId/credits').get(requireAuth, requireAdminCapabilities('billing.read'), controller.getWorkspaceCredits).post(requireAuth, requireAdminCapabilities('billing.manage'), controller.addWorkspaceCredits).all(methodNotAllowed);

router.route('/crm').get(requireAuth, requireAdminCapabilities('workspaces.read'), controller.getCrm).all(methodNotAllowed);
router.route('/websites').get(requireAuth, requireAdminCapabilities('providers.read'), controller.getWebsites).all(methodNotAllowed);
router.route('/agents').get(requireAuth, requireAdminCapabilities('agents.read'), controller.getAgents).all(methodNotAllowed);
router.route('/integrations').get(requireAuth, requireAdminCapabilities('providers.read'), controller.getIntegrations).all(methodNotAllowed);
router.route('/approvals').get(requireAuth, requireAdminCapabilities('agents.read'), controller.getApprovals).all(methodNotAllowed);
router.route('/conversations').get(requireAuth, requireAdminCapabilities('users.read', 'workspaces.read'), controller.getConversations).all(methodNotAllowed);
router.route('/files').get(requireAuth, requireAdminCapabilities('workspaces.read'), controller.getFiles).all(methodNotAllowed);
router.route('/support').get(requireAuth, requireAdminCapabilities('users.read', 'workspaces.read'), controller.getSupport).all(methodNotAllowed);

router.route('/errors').get(requireAuth, requireAdminCapabilities('security.read'), controller.getErrors).all(methodNotAllowed);
router.route('/audit-logs').get(requireAuth, requireAdminCapabilities('audit.read'), controller.getAuditLogs).all(methodNotAllowed);
router.route('/jobs').get(requireAuth, requireAdminCapabilities('agents.read', 'providers.read'), controller.getJobs).all(methodNotAllowed);
router.route('/settings').get(requireAuth, requireAdminCapabilities('security.read'), controller.getSettings).all(methodNotAllowed);

export default router;
