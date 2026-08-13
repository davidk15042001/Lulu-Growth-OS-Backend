import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './conversation.service.js';
import {
  conversationParamsSchema,
  createConversationSchema,
  createMessageSchema,
  generateResponseSchema,
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  updateConversationSchema,
} from './conversation.validator.js';

export async function list(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = conversationParamsSchema.parse(req.params);
    const filters = listConversationsQuerySchema.parse(req.query);
    const result = await service.listConversations(workspaceId, req.user!.id, filters);
    return successResponse(res, 'Conversations loaded', result);
  } catch (error) {
    next(error);
  }
}

export async function get(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = conversationParamsSchema.parse(req.params);
    const conversation = await service.getConversation(params.workspaceId, req.user!.id, params.conversationId!);
    return successResponse(res, 'Conversation loaded', conversation);
  } catch (error) {
    next(error);
  }
}

export async function create(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = conversationParamsSchema.parse(req.params);
    const input = createConversationSchema.parse(req.body);
    const conversation = await service.createConversation(workspaceId, req.user!.id, input);
    return createdResponse(res, 'Conversation created', conversation);
  } catch (error) {
    next(error);
  }
}

export async function update(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = conversationParamsSchema.parse(req.params);
    const input = updateConversationSchema.parse(req.body);
    const conversation = await service.updateConversation(
      params.workspaceId,
      req.user!.id,
      params.conversationId!,
      input
    );
    return successResponse(res, 'Conversation updated', conversation);
  } catch (error) {
    next(error);
  }
}

export async function archive(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = conversationParamsSchema.parse(req.params);
    await service.archiveConversation(params.workspaceId, req.user!.id, params.conversationId!);
    return successResponse(res, 'Conversation archived');
  } catch (error) {
    next(error);
  }
}

export async function listMessages(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = conversationParamsSchema.parse(req.params);
    const filters = listMessagesQuerySchema.parse(req.query);
    const result = await service.listMessages(
      params.workspaceId,
      req.user!.id,
      params.conversationId!,
      filters
    );
    return successResponse(res, 'Messages loaded', result);
  } catch (error) {
    next(error);
  }
}

export async function createMessage(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = conversationParamsSchema.parse(req.params);
    const input = createMessageSchema.parse(req.body);
    const message = await service.createUserMessage(
      params.workspaceId,
      req.user!.id,
      params.conversationId!,
      input
    );
    return createdResponse(res, 'Message created', message);
  } catch (error) {
    next(error);
  }
}

export async function respond(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = conversationParamsSchema.parse(req.params);
    const input = generateResponseSchema.parse(req.body);
    const result = await service.respond(
      params.workspaceId,
      req.user!.id,
      params.conversationId!,
      input
    );
    return createdResponse(res, 'AI response generated', result);
  } catch (error) {
    next(error);
  }
}
