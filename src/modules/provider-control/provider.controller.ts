import type { NextFunction, Request, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import { AppError } from '../../utils/app-error.js';
import * as service from './provider.service.js';
import { connectionParamsSchema, providerMappingQuerySchema, providerMappingSchema, providerModeSchema, providerParamsSchema, providerSyncSchema } from './provider.validator.js';

function workspaceId(req: WorkspaceRequest) {
  const value = req.params.workspaceId;
  if (!value || Array.isArray(value)) throw new AppError(400, 'WORKSPACE_ID_REQUIRED', 'Workspace ID is required');
  return String(value);
}

export async function catalog(_req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { return successResponse(res, 'Provider catalog loaded', { providers: await service.listProviderCatalog() }); }
  catch (error) { next(error); }
}

export async function list(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { return successResponse(res, 'Provider connections loaded', { connections: await service.listWorkspaceProviders(workspaceId(req)) }); }
  catch (error) { next(error); }
}

export async function detail(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { connectionId } = connectionParamsSchema.parse(req.params);
    return successResponse(res, 'Provider connection loaded', await service.getWorkspaceProvider(workspaceId(req), connectionId));
  } catch (error) { next(error); }
}

export async function verify(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { connectionId } = connectionParamsSchema.parse(req.params);
    return successResponse(res, 'Provider connection verification completed', await service.verifyWorkspaceProvider(workspaceId(req), connectionId, req.user!.id));
  } catch (error) { next(error); }
}

export async function changeMode(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { connectionId } = connectionParamsSchema.parse(req.params);
    const { mode } = providerModeSchema.parse(req.body);
    return successResponse(res, 'Provider mode updated', await service.changeWorkspaceProviderMode(workspaceId(req), connectionId, req.user!.id, mode));
  } catch (error) { next(error); }
}

export async function sync(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { connectionId } = connectionParamsSchema.parse(req.params);
    const { syncType } = providerSyncSchema.parse(req.body ?? {});
    return createdResponse(res, 'Provider sync queued', await service.queueWorkspaceProviderSync(workspaceId(req), connectionId, req.user!.id, syncType));
  } catch (error) { next(error); }
}

export async function disconnect(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { connectionId } = connectionParamsSchema.parse(req.params);
    return successResponse(res, 'Provider connection disconnected', await service.disconnectWorkspaceProvider(workspaceId(req), connectionId, req.user!.id));
  } catch (error) { next(error); }
}

export async function listMappings(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const query = providerMappingQuerySchema.parse(req.query);
    return successResponse(res, 'Provider object mappings loaded', { mappings: await service.listWorkspaceProviderMappings(workspaceId(req), query.luluObjectType, query.luluObjectId) });
  } catch (error) { next(error); }
}

export async function createMapping(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const input = providerMappingSchema.parse(req.body);
    const mappingInput = { workspaceId: workspaceId(req), actorId: req.user!.id, providerConnectionId: input.providerConnectionId, providerAccountId: input.providerAccountId, luluObjectType: input.luluObjectType, luluObjectId: input.luluObjectId, externalObjectType: input.externalObjectType, externalObjectId: input.externalObjectId, sourceOfTruth: input.sourceOfTruth, ...(input.providerAssetId === undefined ? {} : { providerAssetId: input.providerAssetId }) };
    return createdResponse(res, 'Provider object mapping created', await service.createWorkspaceProviderMapping(mappingInput));
  } catch (error) { next(error); }
}

export async function webhook(req: Request, res: Response, next: NextFunction) {
  try {
    const { provider } = providerParamsSchema.parse(req.params);
    const rawBody = (req as Request & { rawBody?: string }).rawBody;
    if (!rawBody) throw new AppError(400, 'PROVIDER_WEBHOOK_RAW_BODY_MISSING', 'Provider webhook raw body is missing');
    const payload = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
    const signature = req.header('x-signature') ?? req.header('x-provider-signature');
    const timestamp = req.header('x-timestamp');
    const nonce = req.header('x-nonce');
    const connectionId = req.header('x-lulu-provider-connection-id');
    const accountId = req.header('x-lulu-provider-account-id');
    const correlationId = req.header('x-correlation-id') ?? req.header('x-request-id');
    const eventId = req.header('x-provider-event-id') ?? req.header('x-event-id');
    const result = await service.ingestProviderWebhook({ provider, rawBody, payload, ...(signature ? { signature } : {}), ...(timestamp ? { timestamp } : {}), ...(nonce ? { nonce } : {}), ...(connectionId ? { connectionId } : {}), ...(accountId ? { accountId } : {}), ...(correlationId ? { correlationId } : {}), ...(eventId ? { eventId } : {}) });
    return successResponse(res, result.duplicate ? 'Provider webhook was already processed' : 'Provider webhook accepted', result);
  } catch (error) { next(error); }
}
