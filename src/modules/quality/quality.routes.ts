import { Router } from 'express';
import { requireWorkspaceCapability } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './quality.controller.js';

const router = Router({ mergeParams: true });
const read = requireWorkspaceCapability('quality.read', { enforceWriteEntitlement: false });
const review = requireWorkspaceCapability('quality.review');
const repair = requireWorkspaceCapability('quality.repair');
const release = requireWorkspaceCapability('quality.release');
const override = requireWorkspaceCapability('quality.override');
const admin = requireWorkspaceCapability('quality.admin');

router.get('/overview', read, controller.overview);
router.get('/rubrics', read, controller.rubrics);
router.route('/evidence').post(review, controller.evidence).all(methodNotAllowed);
router.route('/config').get(read, controller.config).patch(admin, controller.updateConfig).all(methodNotAllowed);
router.route('/artifacts').get(read, controller.list).post(review, controller.create).all(methodNotAllowed);
router.route('/artifacts/:artifactId').get(read, controller.get).all(methodNotAllowed);
router.route('/artifacts/:artifactId/reviews').post(review, controller.review).all(methodNotAllowed);
router.route('/artifacts/:artifactId/provider-status').patch(review, controller.providerStatus).all(methodNotAllowed);
router.route('/artifacts/:artifactId/repair').post(repair, controller.repair).all(methodNotAllowed);
router.route('/artifacts/:artifactId/release').post(release, controller.release).all(methodNotAllowed);
router.route('/artifacts/:artifactId/override').post(override, controller.override).all(methodNotAllowed);
router.route('/artifacts/:artifactId/feedback').post(review, controller.feedback).all(methodNotAllowed);
router.route('/artifacts/:artifactId/outcomes').post(review, controller.outcome).all(methodNotAllowed);

export default router;
