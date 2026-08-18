import { Router } from 'express';
import { requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './website.controller.js';

const router = Router({ mergeParams: true });
router.use(requireWorkspaceMember);
router.route('/').get(controller.list).post(controller.create).all(methodNotAllowed);
router.route('/:siteId/domains').post(controller.addDomain).all(methodNotAllowed);
router.route('/:siteId/domains/:domainId/verify').post(controller.verifyDomain).all(methodNotAllowed);
router.route('/:siteId/generation-jobs').post(controller.createJob).all(methodNotAllowed);
router.route('/:siteId/generation-jobs/:jobId').get(controller.getJob).all(methodNotAllowed);
export default router;
