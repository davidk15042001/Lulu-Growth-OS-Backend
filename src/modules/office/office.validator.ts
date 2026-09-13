import { z } from 'zod';
import { officeControlActions, officeWorkItemStatuses } from './office.types.js';

const uuid = z.string().uuid();

export const officeWorkspaceParamsSchema = z.object({ workspaceId: uuid }).passthrough();

export const officeEmployeeParamsSchema = z.object({
  workspaceId: uuid,
  employeeId: uuid,
}).passthrough();

export const officeWorkItemControlParamsSchema = z.object({
  workspaceId: uuid,
  workItemId: uuid,
  action: z.enum(officeControlActions),
}).passthrough();

export const officeOverviewQuerySchema = z.object({
  timelineLimit: z.coerce.number().int().min(1).max(100).default(24),
}).strict();

export const officeEmployeeWorkQuerySchema = z.object({
  status: z.enum(officeWorkItemStatuses).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

export const officeTimelineQuerySchema = z.object({
  employeeId: uuid.optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const officeControlBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  idempotencyKey: z.string().trim().min(8).max(200),
  reason: z.string().trim().min(1).max(2000).optional(),
}).strict();
