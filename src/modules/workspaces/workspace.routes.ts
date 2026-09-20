import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.middleware.js';
import {
  requireWorkspaceAdmin,
  requireWorkspaceMember,
  requireWorkspaceProfileAccess,
  requireWorkspaceActivationGate,
} from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './workspace.controller.js';
import onboardingRoutes from '../onboarding/onboarding.routes.js';
import recordRoutes from '../records/record.routes.js';
import metricRoutes from '../metrics/metric.routes.js';
import notificationRoutes from '../notifications/notification.routes.js';
import conversationRoutes from '../ai/conversation.routes.js';
import agentRoutes from '../agents/agent.routes.js';
import growthApprovalRoutes from '../agents/growth-approval.routes.js';
import workspaceAppRoutes from '../workspace-app/workspace-app.routes.js';
import websiteRoutes from '../websites/website.routes.js';
import usageRoutes from '../usage/usage.routes.js';
import emailRoutes from '../email/email.routes.js';
import calendarRoutes from '../calendar/calendar.routes.js';
import searchIntelligenceRoutes from '../search-intelligence/search-intelligence.routes.js';
import productImageRoutes from '../product-images/product-image.routes.js';
import { acceptInvitation } from '../workspace-app/workspace-app.controller.js';
import workspaceEventRoutes from '../../events/workspace-event.routes.js';
import { workspaceProviderRoutes } from '../provider-control/provider.routes.js';
import productRoutes from '../products/product.routes.js';
import omnichannelRoutes from '../omnichannel/omnichannel.routes.js';
import commercialDocumentRoutes from '../commercial-documents/commercial-documents.routes.js';
import { supportRoutes } from '../support/support.routes.js';
import adSpendRoutes from '../adspend/adspend.routes.js';
import apiWalletRoutes from '../api-wallet/api-wallet.routes.js';
import officeRoutes from '../office/office.routes.js';
import financeRoutes from '../finance/finance.routes.js';
import commerceRoutes from '../commerce/commerce.routes.js';
import socialPublishingRoutes from '../social-publishing/social-publishing.routes.js';
import qualityRoutes from '../quality/quality.routes.js';
import companyBrainRoutes from '../company-brain/company-brain.routes.js';
import salesPipelineRoutes from '../sales-pipeline/sales-pipeline.routes.js';
import multer from 'multer';
import researchRoutes from '../research/research.routes.js';
import composioRoutes from '../composio/composio.routes.js';
import executiveOperatingRoutes from '../executive-ops/executive-ops.routes.js';

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const router = Router();

router.use(requireAuth);

router.route('/')
  .get(controller.list)
  .post(controller.create)
  .all(methodNotAllowed);

router.route('/invitations/:token/accept')
  .post(acceptInvitation)
  .all(methodNotAllowed);

router.get('/:workspaceId', requireWorkspaceMember, controller.get);

router.use('/:workspaceId', requireWorkspaceActivationGate);

router.patch('/:workspaceId', requireWorkspaceAdmin, controller.update);

router.route('/:workspaceId/profile')
  // Company/legal identity is sensitive, but it must remain available during
  // onboarding and before a paid plan exists. Use the explicit workspace role
  // check here instead of the commercial write-entitlement guard.
  .get(requireWorkspaceProfileAccess, controller.getProfile)
  // Company/legal identity is required during onboarding and must remain
  // editable before a paid workspace plan is active. Role authorization still
  // protects the endpoint; ordinary workspace writes remain entitlement-gated.
  .patch(requireWorkspaceProfileAccess, controller.updateProfile)
  .all(methodNotAllowed);

router.route('/:workspaceId/profile/logo')
  .put(requireWorkspaceProfileAccess, logoUpload.single('file'), controller.uploadLogo)
  .delete(requireWorkspaceProfileAccess, controller.deleteLogo)
  .all(methodNotAllowed);

router.use('/:workspaceId', workspaceAppRoutes);
router.use('/:workspaceId/support', supportRoutes);
router.use('/:workspaceId/adspend', adSpendRoutes);
router.use('/:workspaceId/api-wallet', apiWalletRoutes);
router.use('/:workspaceId/office', officeRoutes);
router.use('/:workspaceId/quality', qualityRoutes);
router.use('/:workspaceId/brain', companyBrainRoutes);
router.use('/:workspaceId/executive', executiveOperatingRoutes);
router.use('/:workspaceId/sales-pipeline', salesPipelineRoutes);
router.use('/:workspaceId/finance', financeRoutes);
router.use('/:workspaceId/commerce', commerceRoutes);
router.use('/:workspaceId/social-publishing', socialPublishingRoutes);
router.use('/:workspaceId/providers', workspaceProviderRoutes);
router.use('/:workspaceId/products', productRoutes);
router.use('/:workspaceId/onboarding', onboardingRoutes);
router.use('/:workspaceId/records', recordRoutes);
router.use('/:workspaceId/metrics', metricRoutes);
router.use('/:workspaceId/notifications', notificationRoutes);
router.use('/:workspaceId/ai', conversationRoutes);
router.use('/:workspaceId/agent-runs', agentRoutes);
router.use('/:workspaceId/growth-approvals', growthApprovalRoutes);
router.use('/:workspaceId/websites', websiteRoutes);
router.use('/:workspaceId/search-intelligence', searchIntelligenceRoutes);
router.use('/:workspaceId/research', researchRoutes);
router.use('/:workspaceId/composio', composioRoutes);
router.use('/:workspaceId/product-images', productImageRoutes);
router.use('/:workspaceId/usage', usageRoutes);
router.use('/:workspaceId/email', emailRoutes);
router.use('/:workspaceId/calendar', calendarRoutes);
router.use('/:workspaceId/events', workspaceEventRoutes);
router.use('/:workspaceId/omnichannel', omnichannelRoutes);
router.use('/:workspaceId/commercial-documents', commercialDocumentRoutes);

export default router;
