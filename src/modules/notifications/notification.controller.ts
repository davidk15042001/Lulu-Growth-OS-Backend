import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { notFoundError } from '../../utils/app-error.js';
import { successResponse } from '../../utils/response.js';
import * as repo from './notification.repo.js';
import {
  listNotificationsQuerySchema,
  notificationParamsSchema,
} from './notification.validator.js';

export async function list(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = notificationParamsSchema.parse(req.params);
    const filters = listNotificationsQuerySchema.parse(req.query);
    const result = await repo.listNotifications(workspaceId, req.user!.id, filters);
    return successResponse(res, 'Notifications loaded', result);
  } catch (error) {
    next(error);
  }
}

export async function markRead(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = notificationParamsSchema.parse(req.params);
    const notification = await repo.markRead(params.workspaceId, req.user!.id, params.notificationId!);
    if (!notification) throw notFoundError('Notification not found');
    return successResponse(res, 'Notification marked as read', notification);
  } catch (error) {
    next(error);
  }
}

export async function markAllRead(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = notificationParamsSchema.parse(req.params);
    const updated = await repo.markAllRead(workspaceId, req.user!.id);
    return successResponse(res, 'Notifications marked as read', { updated });
  } catch (error) {
    next(error);
  }
}

export async function dismiss(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = notificationParamsSchema.parse(req.params);
    if (!(await repo.dismiss(params.workspaceId, req.user!.id, params.notificationId!))) {
      throw notFoundError('Notification not found');
    }
    return successResponse(res, 'Notification dismissed');
  } catch (error) {
    next(error);
  }
}
