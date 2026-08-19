import { Router } from 'express';
import { requireWorkspaceEditor, requireWorkspaceMember } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './website.controller.js';

const router = Router({ mergeParams: true });
router.use(requireWorkspaceMember);
router.route('/').get(controller.list).post(requireWorkspaceEditor, controller.create).all(methodNotAllowed);
router.route('/automatic-generation').post(requireWorkspaceEditor, controller.automaticGenerate).all(methodNotAllowed);
router.route('/:siteId/domains').post(requireWorkspaceEditor, controller.addDomain).all(methodNotAllowed);
router.route('/:siteId/domains/:domainId/verify').post(requireWorkspaceEditor, controller.verifyDomain).all(methodNotAllowed);
router.route('/:siteId/generation-jobs').post(requireWorkspaceEditor, controller.createJob).all(methodNotAllowed);
router.route('/:siteId/generation-jobs/:jobId').get(controller.getJob).all(methodNotAllowed);
router.route('/:siteId/generation-jobs/:jobId/publish').post(requireWorkspaceEditor, controller.publishJob).all(methodNotAllowed);
export default router;
