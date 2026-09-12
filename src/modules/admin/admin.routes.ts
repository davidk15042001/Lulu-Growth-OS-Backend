import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './admin.controller.js';

import { requireAdminCapabilities } from './admin.authorization.js';
import * as omni from '../omnichannel/omnichannel.controller.js';
import { streamAdminOmniEvents } from '../omnichannel/omnichannel.stream.js';
import * as commercialDocuments from '../commercial-documents/commercial-documents.controller.js';
import { adminSupportRoutes } from '../support/support.routes.js';
import * as providerController from '../provider-control/provider.controller.js';

const router = Router();

router.route('/dashboard').get(requireAuth, requireAdminCapabilities('users.read', 'workspaces.read', 'billing.read', 'providers.read', 'agents.read', 'security.read'), controller.dashboard).all(methodNotAllowed);
router.route('/search').get(requireAuth, requireAdminCapabilities('users.read', 'workspaces.read', 'providers.read'), controller.searchAll).all(methodNotAllowed);

router.route('/billing-overview').get(requireAuth, requireAdminCapabilities('billing.read'), controller.overview).all(methodNotAllowed);

router.route('/users').get(requireAuth, requireAdminCapabilities('users.read'), controller.getUsers).all(methodNotAllowed);
router.route('/user-deletion-jobs/:jobId').get(requireAuth, requireAdminCapabilities('users.manage'), controller.getUserDeletionJob).all(methodNotAllowed);
router.route('/users/:userId').get(requireAuth, requireAdminCapabilities('users.read', 'workspaces.read', 'billing.read'), controller.getUser).patch(requireAuth, requireAdminCapabilities('users.manage'), controller.patchUser).delete(requireAuth, requireAdminCapabilities('users.manage'), controller.deleteUser).all(methodNotAllowed);
router.route('/users/:userId/impersonate').post(requireAuth, requireAdminCapabilities('users.impersonate'), controller.impersonateUser).all(methodNotAllowed);

router.route('/workspaces').get(requireAuth, requireAdminCapabilities('workspaces.read'), controller.getWorkspaces).all(methodNotAllowed);
router.route('/workspaces/:workspaceId').get(requireAuth, requireAdminCapabilities('workspaces.read', 'billing.read'), controller.getWorkspace).patch(requireAuth, requireAdminCapabilities('workspaces.manage'), controller.patchWorkspace).all(methodNotAllowed);
router.route('/workspaces/:workspaceId/plan').patch(requireAuth, requireAdminCapabilities('billing.manage'), controller.changePlan).all(methodNotAllowed);
router.route('/workspaces/:workspaceId/subscription-price').patch(requireAuth, requireAdminCapabilities('billing.manage'), controller.setWorkspaceSubscriptionPrice).all(methodNotAllowed);
router.route('/workspaces/:workspaceId/credits').get(requireAuth, requireAdminCapabilities('billing.read'), controller.getWorkspaceCredits).post(requireAuth, requireAdminCapabilities('billing.manage'), controller.addWorkspaceCredits).all(methodNotAllowed);
router.route('/workspaces/:workspaceId/usage-adjustments').get(requireAuth, requireAdminCapabilities('billing.read'), controller.getWorkspaceUsageAdjustments).post(requireAuth, requireAdminCapabilities('billing.manage'), controller.addWorkspaceUsageAdjustment).all(methodNotAllowed);
router.route('/workspaces/:workspaceId/usage-costs').put(requireAuth, requireAdminCapabilities('billing.manage'), controller.setWorkspaceUsageCosts).all(methodNotAllowed);

router.route('/crm').get(requireAuth, requireAdminCapabilities('workspaces.read'), controller.getCrm).all(methodNotAllowed);
router.route('/websites').get(requireAuth, requireAdminCapabilities('providers.read'), controller.getWebsites).all(methodNotAllowed);
router.route('/agents').get(requireAuth, requireAdminCapabilities('agents.read'), controller.getAgents).all(methodNotAllowed);
router.route('/integrations').get(requireAuth, requireAdminCapabilities('providers.read'), controller.getIntegrations).all(methodNotAllowed);
router.route('/oauth-connections').get(requireAuth, requireAdminCapabilities('providers.read'), controller.getOAuthConnections).all(methodNotAllowed);
router.route('/oauth-connections/:provider/start').post(requireAuth, requireAdminCapabilities('providers.manage'), controller.startManagedOAuth).all(methodNotAllowed);
router.route('/oauth-connections/:provider').delete(requireAuth, requireAdminCapabilities('providers.manage'), controller.disconnectManagedOAuth).all(methodNotAllowed);
router.route('/oauth-self-service').get(requireAuth, requireAdminCapabilities('providers.read'), controller.getOAuthSelfServicePermissions).all(methodNotAllowed);
router.route('/oauth-self-service/:workspaceId/:provider').put(requireAuth, requireAdminCapabilities('providers.manage'), controller.setOAuthSelfServicePermission).all(methodNotAllowed);
router.route('/provider-control-plane').get(requireAuth, requireAdminCapabilities('providers.read'), controller.getProviderControlPlane).all(methodNotAllowed);
router.route('/provider-control-plane/:connectionId/access').post(requireAuth, requireAdminCapabilities('providers.manage'), controller.grantProviderWorkspaceAccess).delete(requireAuth, requireAdminCapabilities('providers.manage'), controller.revokeProviderWorkspaceAccess).all(methodNotAllowed);
router.route('/unifyport/status').get(requireAuth, requireAdminCapabilities('providers.read'), providerController.unifyPortStatus).all(methodNotAllowed);
router.route('/unifyport/accounts').get(requireAuth, requireAdminCapabilities('providers.read'), providerController.unifyPortAccounts).post(requireAuth, requireAdminCapabilities('providers.manage'), providerController.unifyPortCreateAccount).all(methodNotAllowed);
router.route('/unifyport/accounts/:accountId').get(requireAuth, requireAdminCapabilities('providers.read'), providerController.unifyPortAccount).all(methodNotAllowed);
router.route('/unifyport/accounts/:accountId/auth').get(requireAuth, requireAdminCapabilities('providers.read'), providerController.unifyPortAuth).all(methodNotAllowed);
router.route('/unifyport/accounts/:accountId/auth/qr').post(requireAuth, requireAdminCapabilities('providers.manage'), providerController.unifyPortStartQr).all(methodNotAllowed);
router.route('/unifyport/accounts/:accountId/auth/code').post(requireAuth, requireAdminCapabilities('providers.manage'), providerController.unifyPortStartCode).all(methodNotAllowed);
router.route('/unifyport/identities').put(requireAuth, requireAdminCapabilities('providers.manage'), providerController.unifyPortRegisterIdentity).all(methodNotAllowed);
router.route('/twilio/status').get(requireAuth, requireAdminCapabilities('providers.read'), providerController.twilioStatus).all(methodNotAllowed);
router.route('/twilio/admin-whatsapp-sender').put(requireAuth, requireAdminCapabilities('providers.manage'), providerController.twilioConfigureAdminWhatsAppSender).all(methodNotAllowed);
router.route('/twilio/workspace-accounts').get(requireAuth, requireAdminCapabilities('providers.read'), providerController.twilioWorkspaceAccounts).all(methodNotAllowed);
router.route('/twilio/workspace-accounts/:workspaceId/content-template').put(requireAuth, requireAdminCapabilities('providers.manage'), providerController.twilioConfigureWorkspaceTemplate).all(methodNotAllowed);
router.route('/twilio/identities').post(requireAuth, requireAdminCapabilities('providers.manage'), providerController.twilioRegisterIdentity).all(methodNotAllowed);
router.route('/approvals').get(requireAuth, requireAdminCapabilities('agents.read'), controller.getApprovals).all(methodNotAllowed);
router.route('/conversations').get(requireAuth, requireAdminCapabilities('admin.omnichannel.read_all'), controller.getConversations).all(methodNotAllowed);
router.route('/omnichannel/conversations').get(requireAuth, requireAdminCapabilities('admin.omnichannel.read_all'), omni.adminList).all(methodNotAllowed);
router.route('/omnichannel/events/stream').get(requireAuth, requireAdminCapabilities('admin.omnichannel.read_all'), streamAdminOmniEvents).all(methodNotAllowed);
router.route('/omnichannel/conversations/:conversationId').get(requireAuth, requireAdminCapabilities('admin.omnichannel.read_all'), omni.adminDetail).all(methodNotAllowed);
router.route('/omnichannel/routing').get(requireAuth, requireAdminCapabilities('admin.omnichannel.routing.read'), omni.adminRouting).all(methodNotAllowed);
router.route('/omnichannel/routing/:routingId/resolve').post(requireAuth, requireAdminCapabilities('admin.omnichannel.manage_all'), omni.adminResolve).all(methodNotAllowed);
router.route('/omnichannel/channels').get(requireAuth, requireAdminCapabilities('admin.omnichannel.read_all'), omni.adminChannels).all(methodNotAllowed);
router.route('/omnichannel/analytics').get(requireAuth, requireAdminCapabilities('admin.omnichannel.read_all'), omni.adminAnalytics).all(methodNotAllowed);
router.route('/quotes').get(requireAuth, requireAdminCapabilities('admin.quotes.read_all'), commercialDocuments.adminQuotes).all(methodNotAllowed);
router.route('/invoices').get(requireAuth, requireAdminCapabilities('admin.invoices.read_all'), commercialDocuments.adminInvoices).all(methodNotAllowed);
router.route('/files').get(requireAuth, requireAdminCapabilities('workspaces.read'), controller.getFiles).all(methodNotAllowed);
router.route('/files/:source/:fileId/download').get(requireAuth, requireAdminCapabilities('files.read'), controller.downloadFile).all(methodNotAllowed);
router.use('/support', requireAuth, adminSupportRoutes);

router.route('/errors').get(requireAuth, requireAdminCapabilities('security.read'), controller.getErrors).all(methodNotAllowed);
router.route('/audit-logs').get(requireAuth, requireAdminCapabilities('audit.read'), controller.getAuditLogs).all(methodNotAllowed);
router.route('/jobs').get(requireAuth, requireAdminCapabilities('agents.read', 'providers.read'), controller.getJobs).all(methodNotAllowed);
router.route('/settings').get(requireAuth, requireAdminCapabilities('security.read'), controller.getSettings).all(methodNotAllowed);

export default router;
