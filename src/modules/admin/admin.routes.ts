import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './admin.controller.js';

const router = Router();

router.route('/dashboard').get(requireAuth, controller.dashboard).all(methodNotAllowed);
router.route('/search').get(requireAuth, controller.searchAll).all(methodNotAllowed);

router.route('/billing-overview').get(requireAuth, controller.overview).all(methodNotAllowed);

router.route('/users').get(requireAuth, controller.getUsers).all(methodNotAllowed);
router.route('/users/:userId').get(requireAuth, controller.getUser).patch(requireAuth, controller.patchUser).delete(requireAuth, controller.deleteUser).all(methodNotAllowed);
router.route('/users/:userId/impersonate').post(requireAuth, controller.impersonateUser).all(methodNotAllowed);

router.route('/workspaces').get(requireAuth, controller.getWorkspaces).all(methodNotAllowed);
router.route('/workspaces/:workspaceId').get(requireAuth, controller.getWorkspace).patch(requireAuth, controller.patchWorkspace).all(methodNotAllowed);
router.route('/workspaces/:workspaceId/plan').patch(requireAuth, controller.changePlan).all(methodNotAllowed);
router.route('/workspaces/:workspaceId/credits').get(requireAuth, controller.getWorkspaceCredits).post(requireAuth, controller.addWorkspaceCredits).all(methodNotAllowed);

router.route('/crm').get(requireAuth, controller.getCrm).all(methodNotAllowed);
router.route('/websites').get(requireAuth, controller.getWebsites).all(methodNotAllowed);
router.route('/agents').get(requireAuth, controller.getAgents).all(methodNotAllowed);
router.route('/integrations').get(requireAuth, controller.getIntegrations).all(methodNotAllowed);
router.route('/approvals').get(requireAuth, controller.getApprovals).all(methodNotAllowed);
router.route('/conversations').get(requireAuth, controller.getConversations).all(methodNotAllowed);
router.route('/files').get(requireAuth, controller.getFiles).all(methodNotAllowed);
router.route('/support').get(requireAuth, controller.getSupport).all(methodNotAllowed);

router.route('/errors').get(requireAuth, controller.getErrors).all(methodNotAllowed);
router.route('/audit-logs').get(requireAuth, controller.getAuditLogs).all(methodNotAllowed);
router.route('/jobs').get(requireAuth, controller.getJobs).all(methodNotAllowed);
router.route('/settings').get(requireAuth, controller.getSettings).all(methodNotAllowed);

export default router;
