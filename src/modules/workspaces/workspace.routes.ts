import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.middleware.js';
import {
  requireWorkspaceAdmin,
  requireWorkspaceMember,
  requireWorkspaceRole,
} from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './workspace.controller.js';
import onboardingRoutes from '../onboarding/onboarding.routes.js';
import recordRoutes from '../records/record.routes.js';
import metricRoutes from '../metrics/metric.routes.js';
import notificationRoutes from '../notifications/notification.routes.js';
import conversationRoutes from '../ai/conversation.routes.js';
import agentRoutes from '../agents/agent.routes.js';
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

const router = Router();

router.use(requireAuth);

router.route('/')
  .get(controller.list)
  .post(controller.create)
  .all(methodNotAllowed);

router.route('/invitations/:token/accept')
  .post(acceptInvitation)
  .all(methodNotAllowed);

router.route('/:workspaceId')
  .get(requireWorkspaceMember, controller.get)
  .patch(requireWorkspaceAdmin, controller.update)
  .all(methodNotAllowed);

router.route('/:workspaceId/profile')
  // Company/legal identity is sensitive, but it must remain available during
  // onboarding and before a paid plan exists. Use the explicit workspace role
  // check here instead of the commercial write-entitlement guard.
  .get(requireWorkspaceRole('owner', 'admin'), controller.getProfile)
  // Company/legal identity is required during onboarding and must remain
  // editable before a paid workspace plan is active. Role authorization still
  // protects the endpoint; ordinary workspace writes remain entitlement-gated.
  .patch(requireWorkspaceRole('owner', 'admin'), controller.updateProfile)
  .all(methodNotAllowed);

router.use('/:workspaceId', workspaceAppRoutes);
router.use('/:workspaceId/support', supportRoutes);
router.use('/:workspaceId/adspend', adSpendRoutes);
router.use('/:workspaceId/providers', workspaceProviderRoutes);
router.use('/:workspaceId/products', productRoutes);
router.use('/:workspaceId/onboarding', onboardingRoutes);
router.use('/:workspaceId/records', recordRoutes);
router.use('/:workspaceId/metrics', metricRoutes);
router.use('/:workspaceId/notifications', notificationRoutes);
router.use('/:workspaceId/ai', conversationRoutes);
router.use('/:workspaceId/agent-runs', agentRoutes);
router.use('/:workspaceId/websites', websiteRoutes);
router.use('/:workspaceId/search-intelligence', searchIntelligenceRoutes);
router.use('/:workspaceId/product-images', productImageRoutes);
router.use('/:workspaceId/usage', usageRoutes);
router.use('/:workspaceId/email', emailRoutes);
router.use('/:workspaceId/calendar', calendarRoutes);
router.use('/:workspaceId/events', workspaceEventRoutes);
router.use('/:workspaceId/omnichannel', omnichannelRoutes);
router.use('/:workspaceId/commercial-documents', commercialDocumentRoutes);

export default router;
