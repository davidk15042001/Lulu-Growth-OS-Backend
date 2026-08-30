import { Router } from 'express';
import { requireWorkspaceEditor, requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import { dbRateLimit } from '../../middlewares/rateLimit.middleware.js';
import * as controller from './calendar.controller.js';

const router = Router({ mergeParams: true });
router.use(requireWorkspaceMember);
const rateLimitMessage = 'Too many calendar actions were requested. Please wait and try again.';
const connectionLimiter = dbRateLimit({ keyPrefix: 'calendar-connect', windowMs: 60 * 60 * 1000, limit: 15, message: rateLimitMessage });
const syncLimiter = dbRateLimit({ keyPrefix: 'calendar-sync', windowMs: 60 * 60 * 1000, limit: 60, message: rateLimitMessage });

router.route('/overview').get(controller.overview).all(methodNotAllowed);
router.route('/accounts').get(controller.accounts).all(methodNotAllowed);
router.route('/accounts/oauth/start').post(requireWorkspaceEditor, connectionLimiter, controller.startOAuth).all(methodNotAllowed);
router.route('/accounts/token').post(requireWorkspaceEditor, connectionLimiter, controller.connectToken).all(methodNotAllowed);
router.route('/accounts/:accountId').delete(requireWorkspaceEditor, controller.disconnect).all(methodNotAllowed);
router.route('/accounts/:accountId/sync').post(requireWorkspaceEditor, syncLimiter, controller.startSync).all(methodNotAllowed);
router.route('/accounts/:accountId/sync/:jobId').get(controller.syncJob).all(methodNotAllowed);

export default router;
