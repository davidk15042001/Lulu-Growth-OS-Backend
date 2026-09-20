import type { NextFunction, Response } from 'express';
import { z } from 'zod';
import type { AuthedRequest } from '../../middlewares/auth.middleware.js';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { AppError } from '../../utils/app-error.js';
import { successResponse } from '../../utils/response.js';
import * as service from './composio.service.js';

export async function createSession(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const toolkits = Array.isArray(body.toolkits) ? body.toolkits.filter((value): value is string => typeof value === 'string') : undefined;
    return successResponse(res, 'Composio session created', await service.createWorkspaceSession({ workspaceId, userId: req.user!.id, ...(toolkits ? { toolkits } : {}) }));
  } catch (error) { next(error); }
}

export async function listToolkits(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    return successResponse(res, 'Composio toolkits loaded', await service.listWorkspaceToolkits({ workspaceId, userId: req.user!.id, ...(search ? { search } : {}), ...(cursor ? { cursor } : {}) }));
  } catch (error) { next(error); }
}

export async function listAdminCatalog(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    return successResponse(res, 'Composio admin catalog loaded', await service.listAdminCatalog({
      userId: req.user!.id,
      ...(search ? { search } : {}),
      ...(cursor ? { cursor } : {}),
    }));
  } catch (error) { next(error); }
}

export async function setAdminCatalogAvailability(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const toolkit = typeof req.params.toolkit === 'string' ? req.params.toolkit : '';
    const body = z.object({
      displayName: z.string().min(1).max(200),
      logoUrl: z.string().url().max(1000).nullable().optional(),
      customerAvailable: z.boolean(),
    }).parse(req.body ?? {});
    return successResponse(res, body.customerAvailable ? 'Composio integration published' : 'Composio integration unpublished', await service.setAdminCatalogAvailability({
      toolkit,
      displayName: body.displayName,
      ...(body.logoUrl !== undefined ? { logoUrl: body.logoUrl } : {}),
      customerAvailable: body.customerAvailable,
      adminUserId: req.user!.id,
    }));
  } catch (error) { next(error); }
}

export async function listTools(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    const toolkit = typeof req.query.toolkit === 'string' ? req.query.toolkit : '';
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    return successResponse(res, 'Composio tools loaded', await service.listWorkspaceTools({ workspaceId, userId: req.user!.id, toolkit, ...(search ? { search } : {}) }));
  } catch (error) { next(error); }
}

export async function authorizeToolkit(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const toolkit = typeof body.toolkit === 'string' ? body.toolkit : '';
    return successResponse(res, 'Composio connection link created', await service.authorizeWorkspaceToolkit({ workspaceId, userId: req.user!.id, toolkit }));
  } catch (error) { next(error); }
}

export async function executeTool(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    const body = z.object({
      toolkit: z.string().min(1).max(80),
      toolSlug: z.string().min(1).max(200),
      arguments: z.record(z.string(), z.unknown()).default({}),
      idempotencyKey: z.string().min(1).max(240).optional(),
    }).parse(req.body ?? {});
    const idempotencyKey = body.idempotencyKey ?? req.header('idempotency-key') ?? '';
    if (!idempotencyKey) throw new AppError(400, 'COMPOSIO_IDEMPOTENCY_KEY_REQUIRED', 'Composio tool calls require an idempotency key.');
    return successResponse(res, 'Composio tool executed', await service.executeWorkspaceTool({
      workspaceId,
      userId: req.user!.id,
      toolkit: body.toolkit,
      toolSlug: body.toolSlug,
      arguments: body.arguments,
      idempotencyKey,
    }));
  } catch (error) { next(error); }
}

export async function createTrigger(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    const body = z.object({
      triggerSlug: z.string().min(1).max(200),
      toolkit: z.string().min(1).max(80).optional(),
      triggerConfig: z.record(z.string(), z.unknown()).optional(),
      connectedAccountId: z.string().min(1).max(240).optional(),
    }).parse(req.body ?? {});
    return successResponse(res, 'Composio trigger created', await service.createWorkspaceTrigger({
      workspaceId,
      userId: req.user!.id,
      triggerSlug: body.triggerSlug,
      ...(body.toolkit ? { toolkit: body.toolkit } : {}),
      ...(body.triggerConfig ? { triggerConfig: body.triggerConfig } : {}),
      ...(body.connectedAccountId ? { connectedAccountId: body.connectedAccountId } : {}),
    }));
  } catch (error) { next(error); }
}

export async function webhook(req: import('express').Request, res: Response, next: NextFunction) {
  try {
    const rawBody = (req as typeof req & { rawBody?: string }).rawBody;
    if (!rawBody) throw new AppError(400, 'COMPOSIO_WEBHOOK_RAW_BODY_MISSING', 'Composio webhook raw body is missing.');
    return successResponse(res, 'Composio webhook accepted', await service.handleComposioWebhook({
      rawBody,
      headers: req.headers,
    }));
  } catch (error) { next(error); }
}
