import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import type {
  CreateNotificationInput,
  ListNotificationsQuery,
} from './notification.validator.js';

type Notification = {
  id: string;
  workspaceId: string;
  notificationType: string;
  severity: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};

const notificationSelect = `
  id,
  workspace_id AS "workspaceId",
  notification_type AS "notificationType",
  severity,
  title,
  body,
  entity_type AS "entityType",
  entity_id AS "entityId",
  data,
  read_at AS "readAt",
  created_at AS "createdAt"
`;

export async function createNotification(input: CreateNotificationInput) {
  return withTransaction(async (client) => {
    const { rows } = await query<Notification>(
      `INSERT INTO notifications (
         workspace_id, user_id, notification_type, severity, title, body,
         entity_type, entity_id, data
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${notificationSelect}`,
      [
        input.workspaceId,
        input.userId,
        input.notificationType,
        input.severity ?? 'info',
        input.title,
        input.body ?? null,
        input.entityType ?? null,
        input.entityId ?? null,
        input.data ?? {},
      ],
      client,
    );
    const notification = rows[0];
    if (!notification) throw new Error('Notification insert did not return a row');
    await appendDomainEvent({
      workspaceId: input.workspaceId,
      type: DOMAIN_EVENT_TYPES.NOTIFICATION_CREATED,
      aggregateType: 'notification',
      aggregateId: notification.id,
      payload: {
        notificationId: notification.id,
        userId: input.userId,
        notificationType: notification.notificationType,
        severity: notification.severity,
      },
      metadata: { source: 'notifications' },
      idempotencyKey: `notification:${notification.id}:created:v1`,
    }, client);
    return notification;
  });
}

export async function listNotifications(
  workspaceId: string,
  userId: string,
  filters: ListNotificationsQuery
) {
  const values: unknown[] = [workspaceId, userId];
  const conditions = ['workspace_id = $1', 'user_id = $2', 'dismissed_at IS NULL'];
  if (filters.unreadOnly) conditions.push('read_at IS NULL');
  if (filters.severity) {
    values.push(filters.severity);
    conditions.push(`severity = $${values.length}`);
  }
  const where = conditions.join(' AND ');
  const offset = (filters.page - 1) * filters.limit;

  const [items, count, unread] = await Promise.all([
    query<Notification>(
      `SELECT ${notificationSelect}
       FROM notifications
       WHERE ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, filters.limit, offset]
    ),
    query<{ total: string }>(`SELECT count(*)::text AS total FROM notifications WHERE ${where}`, values),
    query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM notifications
       WHERE workspace_id = $1 AND user_id = $2 AND read_at IS NULL AND dismissed_at IS NULL`,
      [workspaceId, userId]
    ),
  ]);

  const total = Number.parseInt(count.rows[0]?.total ?? '0', 10);
  return {
    items: items.rows,
    unread: Number.parseInt(unread.rows[0]?.total ?? '0', 10),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      pages: Math.ceil(total / filters.limit),
    },
  };
}

export async function markRead(workspaceId: string, userId: string, notificationId: string) {
  const { rows } = await query<Notification>(
    `UPDATE notifications
     SET read_at = COALESCE(read_at, NOW())
     WHERE workspace_id = $1 AND user_id = $2 AND id = $3 AND dismissed_at IS NULL
     RETURNING ${notificationSelect}`,
    [workspaceId, userId, notificationId]
  );
  return rows[0];
}

export async function markAllRead(workspaceId: string, userId: string) {
  const { rowCount } = await query(
    `UPDATE notifications
     SET read_at = NOW()
     WHERE workspace_id = $1 AND user_id = $2 AND read_at IS NULL AND dismissed_at IS NULL`,
    [workspaceId, userId]
  );
  return rowCount;
}

export async function dismiss(workspaceId: string, userId: string, notificationId: string) {
  const { rowCount } = await query(
    `UPDATE notifications
     SET dismissed_at = NOW()
     WHERE workspace_id = $1 AND user_id = $2 AND id = $3 AND dismissed_at IS NULL`,
    [workspaceId, userId, notificationId]
  );
  return rowCount > 0;
}
