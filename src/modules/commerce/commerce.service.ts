import { assertWorkspaceScope } from '../../db/workspace-scope.js';
import { notFoundError } from '../../utils/app-error.js';
import * as repo from './commerce.repo.js';
import type { CommerceActor } from './commerce.types.js';
import type {
  AdjustInventoryInput,
  CreateFulfillmentInput,
  CreateInventoryLocationInput,
  CreateOrderInput,
  ListInventoryLevelsQuery,
  ListInventoryMovementsQuery,
  ListOrdersQuery,
  TransitionFulfillmentInput,
  TransitionOrderInput,
  UpdateInventoryLocationInput,
  UpdateOrderInput,
} from './commerce.validator.js';

function scope(workspaceId: string) {
  return assertWorkspaceScope(workspaceId);
}

export function listOrders(workspaceId: string, filters: ListOrdersQuery) {
  return repo.listOrders(scope(workspaceId), filters);
}

export async function getOrder(workspaceId: string, orderId: string) {
  const order = await repo.getOrder(scope(workspaceId), orderId);
  if (!order) throw notFoundError('Order not found');
  return order;
}

/** Canonical entry point shared by manual HTTP actions and autonomous agents. */
export async function createOrder(workspaceId: string, actor: CommerceActor, input: CreateOrderInput) {
  const order = await repo.createOrder(scope(workspaceId), actor, input);
  if (!order) throw new Error('Created order could not be loaded');
  return order;
}

export async function updateOrder(
  workspaceId: string,
  orderId: string,
  actor: CommerceActor,
  input: UpdateOrderInput,
) {
  const order = await repo.updateOrder(scope(workspaceId), orderId, actor, input);
  if (!order) throw notFoundError('Order not found');
  return order;
}

export async function transitionOrder(
  workspaceId: string,
  orderId: string,
  actor: CommerceActor,
  input: TransitionOrderInput,
) {
  const order = await repo.transitionOrder(scope(workspaceId), orderId, actor, input);
  if (!order) throw notFoundError('Order not found');
  return order;
}

export function listInventoryLocations(workspaceId: string, status?: string) {
  return repo.listInventoryLocations(scope(workspaceId), status);
}

export async function getInventoryLocation(workspaceId: string, locationId: string) {
  const location = await repo.getInventoryLocation(scope(workspaceId), locationId);
  if (!location) throw notFoundError('Inventory location not found');
  return location;
}

export async function createInventoryLocation(
  workspaceId: string,
  actor: CommerceActor,
  input: CreateInventoryLocationInput,
) {
  const location = await repo.createInventoryLocation(scope(workspaceId), actor, input);
  if (!location) throw new Error('Created inventory location could not be loaded');
  return location;
}

export async function updateInventoryLocation(
  workspaceId: string,
  locationId: string,
  actor: CommerceActor,
  input: UpdateInventoryLocationInput,
) {
  const location = await repo.updateInventoryLocation(scope(workspaceId), locationId, actor, input);
  if (!location) throw notFoundError('Inventory location not found');
  return location;
}

export function listInventoryLevels(workspaceId: string, filters: ListInventoryLevelsQuery) {
  return repo.listInventoryLevels(scope(workspaceId), filters);
}

export async function getInventoryLevel(workspaceId: string, levelId: string) {
  const level = await repo.getInventoryLevel(scope(workspaceId), levelId);
  if (!level) throw notFoundError('Inventory level not found');
  return level;
}

export async function adjustInventory(
  workspaceId: string,
  actor: CommerceActor,
  input: AdjustInventoryInput,
) {
  const level = await repo.adjustInventory(scope(workspaceId), actor, input);
  if (!level) throw new Error('Adjusted inventory level could not be loaded');
  return level;
}

export function listInventoryMovements(workspaceId: string, filters: ListInventoryMovementsQuery) {
  return repo.listInventoryMovements(scope(workspaceId), filters);
}

export function listFulfillments(workspaceId: string, orderId: string) {
  return repo.listFulfillments(scope(workspaceId), orderId);
}

export async function getFulfillment(workspaceId: string, orderId: string, fulfillmentId: string) {
  const fulfillment = await repo.getFulfillment(scope(workspaceId), orderId, fulfillmentId);
  if (!fulfillment) throw notFoundError('Fulfillment not found');
  return fulfillment;
}

export async function createFulfillment(
  workspaceId: string,
  orderId: string,
  actor: CommerceActor,
  input: CreateFulfillmentInput,
) {
  const fulfillment = await repo.createFulfillment(scope(workspaceId), orderId, actor, input);
  if (!fulfillment) throw new Error('Created fulfillment could not be loaded');
  return fulfillment;
}

export async function transitionFulfillment(
  workspaceId: string,
  orderId: string,
  fulfillmentId: string,
  actor: CommerceActor,
  input: TransitionFulfillmentInput,
) {
  const fulfillment = await repo.transitionFulfillment(
    scope(workspaceId),
    orderId,
    fulfillmentId,
    actor,
    input,
  );
  if (!fulfillment) throw notFoundError('Fulfillment not found');
  return fulfillment;
}
