import { z } from 'zod';

export const notificationParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  notificationId: z.string().uuid().optional(),
});

export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  unreadOnly: z.enum(['true', 'false']).transform((value) => value === 'true').default(false),
  severity: z.enum(['info', 'success', 'warning', 'critical']).optional(),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export type CreateNotificationInput = {
  workspaceId: string;
  userId: string;
  notificationType: string;
  severity?: 'info' | 'success' | 'warning' | 'critical';
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  data?: Record<string, unknown>;
};
