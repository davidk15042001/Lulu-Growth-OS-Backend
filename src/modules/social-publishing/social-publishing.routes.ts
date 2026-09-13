import { Router } from 'express';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import { requireWorkspaceCapability } from '../../middlewares/workspace.middleware.js';
import * as controller from './social-publishing.controller.js';

/** Mount at `/api/v1/workspaces/:workspaceId/social-publishing`.
 * Publishing corporate content is deliberately narrower than generic workspace
 * editing. The same dedicated capabilities protect UI, API and automated paths. */
const router = Router({ mergeParams: true });
const canRead = requireWorkspaceCapability('social.read', { enforceWriteEntitlement: false });
const canManage = requireWorkspaceCapability('social.manage');
const canPublish = requireWorkspaceCapability('social.publish');
router.route('/accounts').get(canRead, controller.listAccounts).post(canManage, controller.createAccount).all(methodNotAllowed);
router.route('/accounts/:accountId').get(canRead, controller.getAccount).all(methodNotAllowed);
router.route('/accounts/:accountId/verify').post(canManage, controller.verifyAccount).all(methodNotAllowed);
router.route('/content').get(canRead, controller.listContent).post(canManage, controller.createContent).all(methodNotAllowed);
router.route('/content/:contentId').get(canRead, controller.getContent).patch(canManage, controller.updateContent).all(methodNotAllowed);
router.route('/publications').get(canRead, controller.listPublications).post(canPublish, controller.createPublication).all(methodNotAllowed);
router.route('/publications/:publicationId').get(canRead, controller.getPublication).all(methodNotAllowed);
router.route('/publications/:publicationId/queue').post(canPublish, controller.queuePublication).all(methodNotAllowed);
router.route('/publications/:publicationId/retry').post(canPublish, controller.retryPublication).all(methodNotAllowed);
router.route('/publications/:publicationId/cancel').post(canPublish, controller.cancelPublication).all(methodNotAllowed);

export default router;
