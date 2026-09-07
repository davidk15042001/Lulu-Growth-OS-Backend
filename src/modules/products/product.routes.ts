import { Router } from 'express';
import { requireWorkspaceCapability } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './product.controller.js';

const router = Router({ mergeParams: true });
router.route('/').get(requireWorkspaceCapability('products.read'), controller.list).post(requireWorkspaceCapability('products.create'), controller.create).all(methodNotAllowed);
router.route('/:productId').get(requireWorkspaceCapability('products.read'), controller.get).patch(requireWorkspaceCapability('products.update'), controller.update).delete(requireWorkspaceCapability('products.delete'), controller.archive).all(methodNotAllowed);
router.route('/:productId/details/:childType').get(requireWorkspaceCapability('products.read'), controller.listChild).post(requireWorkspaceCapability('products.update'), controller.createChild).all(methodNotAllowed);
router.route('/:productId/details/:childType/:childId').delete(requireWorkspaceCapability('products.update'), controller.deleteChild).all(methodNotAllowed);
router.route('/:productId/relationships').post(requireWorkspaceCapability('products.update'), controller.createRelationship).all(methodNotAllowed);
router.route('/:productId/relationships/:childId').delete(requireWorkspaceCapability('products.update'), controller.deleteRelationship).all(methodNotAllowed);
export default router;
