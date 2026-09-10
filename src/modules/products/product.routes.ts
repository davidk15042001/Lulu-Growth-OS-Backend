import { Router } from 'express';
import { requireWorkspaceCapability } from '../../middlewares/workspace.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './product.controller.js';
import multer from 'multer';
import * as premiumMediaController from '../premium-media/premium-media.controller.js';

const router = Router({ mergeParams: true });
const premiumMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 4, fields: 10 },
});
router.route('/categories').get(requireWorkspaceCapability('products.read'), controller.listCategories).post(requireWorkspaceCapability('products.update'), controller.createCategory).all(methodNotAllowed);
router.route('/categories/:categoryId').patch(requireWorkspaceCapability('products.update'), controller.updateCategory).delete(requireWorkspaceCapability('products.delete'), controller.archiveCategory).all(methodNotAllowed);
router.route('/').get(requireWorkspaceCapability('products.read'), controller.list).post(requireWorkspaceCapability('products.create'), controller.create).all(methodNotAllowed);
router.route('/:productId/premium-media')
  .get(requireWorkspaceCapability('products.read'), premiumMediaController.latest)
  .post(requireWorkspaceCapability('products.update'), premiumMediaUpload.array('references', 4), premiumMediaController.start)
  .all(methodNotAllowed);
router.route('/:productId/premium-media/assets/:candidateId')
  .get(requireWorkspaceCapability('products.read'), premiumMediaController.asset)
  .all(methodNotAllowed);
router.route('/:productId/premium-media/:jobId')
  .get(requireWorkspaceCapability('products.read'), premiumMediaController.get)
  .all(methodNotAllowed);
router.route('/:productId').get(requireWorkspaceCapability('products.read'), controller.get).patch(requireWorkspaceCapability('products.update'), controller.update).delete(requireWorkspaceCapability('products.delete'), controller.archive).all(methodNotAllowed);
router.route('/:productId/details/:childType').get(requireWorkspaceCapability('products.read'), controller.listChild).post(requireWorkspaceCapability('products.update'), controller.createChild).all(methodNotAllowed);
router.route('/:productId/details/:childType/:childId').delete(requireWorkspaceCapability('products.update'), controller.deleteChild).all(methodNotAllowed);
router.route('/:productId/relationships').post(requireWorkspaceCapability('products.update'), controller.createRelationship).all(methodNotAllowed);
router.route('/:productId/relationships/:childId').delete(requireWorkspaceCapability('products.update'), controller.deleteRelationship).all(methodNotAllowed);
export default router;
