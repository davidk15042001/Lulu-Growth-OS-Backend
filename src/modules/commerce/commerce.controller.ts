import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './commerce.service.js';
import type { CommerceActor } from './commerce.types.js';
import {
  adjustInventorySchema,
  commerceWorkspaceParamsSchema,
  createFulfillmentSchema,
  createInventoryLocationSchema,
  createOrderSchema,
  fulfillmentParamsSchema,
  levelParamsSchema,
  listInventoryLevelsQuerySchema,
  listInventoryLocationsQuerySchema,
  listInventoryMovementsQuerySchema,
  listOrdersQuerySchema,
  locationParamsSchema,
  orderParamsSchema,
  transitionFulfillmentSchema,
  transitionOrderSchema,
  updateInventoryLocationSchema,
  updateOrderSchema,
} from './commerce.validator.js';

function actor(req: WorkspaceRequest): CommerceActor {
  if (!req.user?.id) throw new Error('Authentication is required');
  return {
    actorType: 'USER',
    actorRef: req.user.id,
    correlationId: typeof req.id === 'string' ? req.id : null,
  };
}

export async function listOrders(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = commerceWorkspaceParamsSchema.parse(req.params);
    return successResponse(res, 'Orders loaded', await service.listOrders(workspaceId, listOrdersQuerySchema.parse(req.query)));
  } catch (error) { next(error); }
}

export async function getOrder(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = orderParamsSchema.parse(req.params);
    return successResponse(res, 'Order loaded', await service.getOrder(params.workspaceId, params.orderId));
  } catch (error) { next(error); }
}

export async function createOrder(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = commerceWorkspaceParamsSchema.parse(req.params);
    return createdResponse(res, 'Order created', await service.createOrder(workspaceId, actor(req), createOrderSchema.parse(req.body)));
  } catch (error) { next(error); }
}

export async function updateOrder(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = orderParamsSchema.parse(req.params);
    return successResponse(res, 'Order updated', await service.updateOrder(params.workspaceId, params.orderId, actor(req), updateOrderSchema.parse(req.body)));
  } catch (error) { next(error); }
}

export async function transitionOrder(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = orderParamsSchema.parse(req.params);
    return successResponse(res, 'Order status updated', await service.transitionOrder(params.workspaceId, params.orderId, actor(req), transitionOrderSchema.parse(req.body)));
  } catch (error) { next(error); }
}

export async function listLocations(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = commerceWorkspaceParamsSchema.parse(req.params);
    const query = listInventoryLocationsQuerySchema.parse(req.query);
    return successResponse(res, 'Inventory locations loaded', await service.listInventoryLocations(workspaceId, query.status));
  } catch (error) { next(error); }
}

export async function getLocation(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = locationParamsSchema.parse(req.params);
    return successResponse(res, 'Inventory location loaded', await service.getInventoryLocation(params.workspaceId, params.locationId));
  } catch (error) { next(error); }
}

export async function createLocation(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = commerceWorkspaceParamsSchema.parse(req.params);
    return createdResponse(res, 'Inventory location created', await service.createInventoryLocation(workspaceId, actor(req), createInventoryLocationSchema.parse(req.body)));
  } catch (error) { next(error); }
}

export async function updateLocation(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = locationParamsSchema.parse(req.params);
    return successResponse(res, 'Inventory location updated', await service.updateInventoryLocation(params.workspaceId, params.locationId, actor(req), updateInventoryLocationSchema.parse(req.body)));
  } catch (error) { next(error); }
}

export async function listLevels(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = commerceWorkspaceParamsSchema.parse(req.params);
    return successResponse(res, 'Inventory levels loaded', await service.listInventoryLevels(workspaceId, listInventoryLevelsQuerySchema.parse(req.query)));
  } catch (error) { next(error); }
}

export async function getLevel(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = levelParamsSchema.parse(req.params);
    return successResponse(res, 'Inventory level loaded', await service.getInventoryLevel(params.workspaceId, params.levelId));
  } catch (error) { next(error); }
}

export async function adjustLevel(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = commerceWorkspaceParamsSchema.parse(req.params);
    return successResponse(res, 'Inventory adjusted', await service.adjustInventory(workspaceId, actor(req), adjustInventorySchema.parse(req.body)));
  } catch (error) { next(error); }
}

export async function listMovements(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = commerceWorkspaceParamsSchema.parse(req.params);
    return successResponse(res, 'Inventory movements loaded', await service.listInventoryMovements(workspaceId, listInventoryMovementsQuerySchema.parse(req.query)));
  } catch (error) { next(error); }
}

export async function listFulfillments(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = orderParamsSchema.parse(req.params);
    return successResponse(res, 'Fulfillments loaded', await service.listFulfillments(params.workspaceId, params.orderId));
  } catch (error) { next(error); }
}

export async function getFulfillment(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = fulfillmentParamsSchema.parse(req.params);
    return successResponse(res, 'Fulfillment loaded', await service.getFulfillment(params.workspaceId, params.orderId, params.fulfillmentId));
  } catch (error) { next(error); }
}

export async function createFulfillment(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = orderParamsSchema.parse(req.params);
    return createdResponse(res, 'Fulfillment created', await service.createFulfillment(params.workspaceId, params.orderId, actor(req), createFulfillmentSchema.parse(req.body)));
  } catch (error) { next(error); }
}

export async function transitionFulfillment(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = fulfillmentParamsSchema.parse(req.params);
    return successResponse(res, 'Fulfillment status updated', await service.transitionFulfillment(params.workspaceId, params.orderId, params.fulfillmentId, actor(req), transitionFulfillmentSchema.parse(req.body)));
  } catch (error) { next(error); }
}
