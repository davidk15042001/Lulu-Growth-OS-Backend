import { Router } from 'express';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import { requireWorkspaceCapability } from '../../middlewares/workspace.middleware.js';
import * as controller from './commerce.controller.js';

const router = Router({ mergeParams: true });

router.route('/orders')
  .get(requireWorkspaceCapability('orders.read'), controller.listOrders)
  .post(requireWorkspaceCapability('orders.manage'), controller.createOrder)
  .all(methodNotAllowed);
router.route('/orders/:orderId')
  .get(requireWorkspaceCapability('orders.read'), controller.getOrder)
  .patch(requireWorkspaceCapability('orders.manage'), controller.updateOrder)
  .all(methodNotAllowed);
router.route('/orders/:orderId/transitions')
  .post(requireWorkspaceCapability('orders.manage'), controller.transitionOrder)
  .all(methodNotAllowed);
router.route('/orders/:orderId/fulfillments')
  .get(requireWorkspaceCapability('orders.read'), controller.listFulfillments)
  .post(requireWorkspaceCapability('orders.manage'), controller.createFulfillment)
  .all(methodNotAllowed);
router.route('/orders/:orderId/fulfillments/:fulfillmentId')
  .get(requireWorkspaceCapability('orders.read'), controller.getFulfillment)
  .all(methodNotAllowed);
router.route('/orders/:orderId/fulfillments/:fulfillmentId/transitions')
  .post(requireWorkspaceCapability('orders.manage'), controller.transitionFulfillment)
  .all(methodNotAllowed);

router.route('/inventory/locations')
  .get(requireWorkspaceCapability('orders.read'), controller.listLocations)
  .post(requireWorkspaceCapability('orders.manage'), controller.createLocation)
  .all(methodNotAllowed);
router.route('/inventory/locations/:locationId')
  .get(requireWorkspaceCapability('orders.read'), controller.getLocation)
  .patch(requireWorkspaceCapability('orders.manage'), controller.updateLocation)
  .all(methodNotAllowed);
router.route('/inventory/levels')
  .get(requireWorkspaceCapability('orders.read'), controller.listLevels)
  .all(methodNotAllowed);
router.route('/inventory/levels/:levelId')
  .get(requireWorkspaceCapability('orders.read'), controller.getLevel)
  .all(methodNotAllowed);
router.route('/inventory/adjustments')
  .post(requireWorkspaceCapability('orders.manage'), controller.adjustLevel)
  .all(methodNotAllowed);
router.route('/inventory/movements')
  .get(requireWorkspaceCapability('orders.read'), controller.listMovements)
  .all(methodNotAllowed);

export default router;
