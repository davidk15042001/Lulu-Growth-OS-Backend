import { Router } from 'express';
import authRoutes from './auth/auth.routes.js';
import workspaceRoutes from './workspaces/workspace.routes.js';
import translationRoutes from './translations/translation.routes.js';
import { RESOURCE_CATALOG, RESOURCE_DOMAINS } from '../domain/resource-catalog.js';

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

router.get('/resource-types', (_req, res) => {
  res.json({ success: true, data: { items: RESOURCE_CATALOG } });
});

router.use('/auth', authRoutes);
router.use('/translations', translationRoutes);
router.use('/workspaces', workspaceRoutes);

export default router;
