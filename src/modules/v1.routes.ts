import { Router } from 'express';
import authRoutes from './auth/auth.routes.js';
import workspaceRoutes from './workspaces/workspace.routes.js';
import translationRoutes from './translations/translation.routes.js';
import oauthRoutes from './onboarding/oauth.routes.js';
import { RESOURCE_CATALOG, RESOURCE_DOMAINS } from '../domain/resource-catalog.js';
import { env } from '../config/env.js';
import { checkDatabase } from '../db/pool.js';
import { getAiProviderHealth } from './ai/openai.service.js';
import billingRoutes from './billing/billing.routes.js';
import adminRoutes from './admin/admin.routes.js';
import emailOAuthRoutes from './email/email.oauth.routes.js';
import calendarOAuthRoutes from './calendar/calendar.oauth.routes.js';
import { publicCalendarRoutes } from './calendar/calendar.routes.js';
import publicRoutes from './public/public.routes.js';
import { providerWebhookRoutes } from './provider-control/provider.routes.js';
import { publicOmniRouter } from './omnichannel/omnichannel.routes.js';
import { publicCommercialDocumentRoutes } from './commercial-documents/commercial-documents.routes.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    success: true,
    data: {
      name: 'Lulu Growth OS API',
      version: 'v1',
      domains: RESOURCE_DOMAINS,
    },
  });
});

router.get('/health', (_req, res) => {
  res.status(200).json({
    success: true,
    data: { status: 'ok', environment: env.NODE_ENV, timestamp: new Date().toISOString() },
  });
});

router.get('/ready', async (_req, res, next) => {
  try {
    const database = await checkDatabase();
    const ready = database.configured && database.connected;
    const aiProviders = getAiProviderHealth().map(({ lastError: _lastError, ...provider }) => provider);
    res.status(ready ? 200 : 503).json({
      success: ready,
      data: { status: ready ? (aiProviders.some((provider) => provider.available) ? 'ready' : 'degraded') : 'not_ready', database, aiProviders },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/resource-types', (_req, res) => {
  res.json({ success: true, data: { items: RESOURCE_CATALOG } });
});

router.use('/auth', authRoutes);
router.use('/translations', translationRoutes);
router.use('/onboarding/oauth', oauthRoutes);
router.use('/billing', billingRoutes);
router.use('/admin', adminRoutes);
router.use('/email', emailOAuthRoutes);
router.use('/calendar', calendarOAuthRoutes);
router.use('/public/calendar', publicCalendarRoutes);
router.use('/public', publicRoutes);
router.use('/provider-webhooks', providerWebhookRoutes);
router.use('/public/omnichannel', publicOmniRouter);
router.use('/public/commercial-documents', publicCommercialDocumentRoutes);
router.use('/workspaces', workspaceRoutes);

export default router;
