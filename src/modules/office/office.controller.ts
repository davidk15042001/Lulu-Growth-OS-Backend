import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { successResponse } from '../../utils/response.js';
import { hasWorkspaceEntitlement } from '../entitlements/entitlement.service.js';
import { getWorkspaceActorCapabilities } from '../workspaces/workspace-authorization.service.js';
import * as service from './office.service.js';
import {
  officeControlBodySchema,
  officeEmployeeParamsSchema,
  officeEmployeeWorkQuerySchema,
  officeOverviewQuerySchema,
  officeTimelineQuerySchema,
  officeWorkItemControlParamsSchema,
  officeWorkspaceParamsSchema,
} from './office.validator.js';

async function actorContext(req: WorkspaceRequest, workspaceId: string) {
  const access = await getWorkspaceActorCapabilities(workspaceId, req.user!.id);
  const canControl = access.capabilities.has('agents.manage')
    && await hasWorkspaceEntitlement(workspaceId, 'workspace.write');
  return { access, canControl };
}

function actorAccess(req: WorkspaceRequest, workspaceId: string) {
  return getWorkspaceActorCapabilities(workspaceId, req.user!.id);
}

export async function overview(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = officeWorkspaceParamsSchema.parse(req.params);
    const { timelineLimit } = officeOverviewQuerySchema.parse(req.query);
    const access = await actorAccess(req, workspaceId);
    return successResponse(res, 'Office overview loaded', await service.getOverview(workspaceId, timelineLimit, access));
  } catch (error) { next(error); }
}

export async function employeeDetail(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, employeeId } = officeEmployeeParamsSchema.parse(req.params);
    const { access, canControl } = await actorContext(req, workspaceId);
    return successResponse(res, 'Digital employee loaded', await service.getEmployeeDetailForActor(workspaceId, employeeId, access, canControl));
  } catch (error) { next(error); }
}

export async function employeeWork(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, employeeId } = officeEmployeeParamsSchema.parse(req.params);
    const query = officeEmployeeWorkQuerySchema.parse(req.query);
    const { access, canControl } = await actorContext(req, workspaceId);
    return successResponse(res, 'Digital employee work loaded', await service.getEmployeeWork({
      workspaceId, employeeId, ...query,
      access, canControl,
    }));
  } catch (error) { next(error); }
}

export async function timeline(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = officeWorkspaceParamsSchema.parse(req.params);
    const input = officeTimelineQuerySchema.parse(req.query);
    const access = await actorAccess(req, workspaceId);
    return successResponse(res, 'Office timeline loaded', await service.getTimeline({ workspaceId, ...input, access }));
  } catch (error) { next(error); }
}

export async function controlWorkItem(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = officeWorkItemControlParamsSchema.parse(req.params);
    const input = officeControlBodySchema.parse(req.body);
    return successResponse(res, 'Office work item control applied', await service.controlWorkItem({
      ...params, ...input, actorId: req.user!.id,
    }));
  } catch (error) { next(error); }
}
