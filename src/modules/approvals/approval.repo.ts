import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import type {
  CreateApprovalInput,
  DecideApprovalInput,
  ListApprovalsQuery,
} from './approval.validator.js';

type Approval = {
  id: string;
  workspaceId: string;
  requestedBy: string | null;
  assignedTo: string | null;
  actionType: string;
  entityType: string | null;
  entityId: string | null;
  title: string;
  description: string | null;
  impactAmount: string | null;
  impactCurrency: string | null;
  payload: Record<string, unknown>;
  status: string;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const approvalSelect = `
  id,
  workspace_id AS "workspaceId",
  requested_by AS "requestedBy",
  assigned_to AS "assignedTo",
  action_type AS "actionType",
  entity_type AS "entityType",
  entity_id AS "entityId",
  title,
  description,
  impact_amount AS "impactAmount",
  impact_currency AS "impactCurrency",
  payload,
  status,
  decision_note AS "decisionNote",
  decided_by AS "decidedBy",
  decided_at AS "decidedAt",
  expires_at AS "expiresAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function listApprovals(
  workspaceId: string,
  userId: string,
  canViewAll: boolean,
  filters: ListApprovalsQuery
) {
  const values: unknown[] = [workspaceId];
  const conditions = ['workspace_id = $1'];
  if (!canViewAll || filters.mine) {
    values.push(userId);
    conditions.push(`(assigned_to = $${values.length} OR requested_by = $${values.length})`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  const where = conditions.join(' AND ');
  const offset = (filters.page - 1) * filters.limit;

  const [items, count] = await Promise.all([
    query<Approval>(
      `SELECT ${approvalSelect}
       FROM approval_requests
       WHERE ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, filters.limit, offset]
    ),
    query<{ total: string }>(
      `SELECT count(*)::text AS total FROM approval_requests WHERE ${where}`,
      values
    ),
  ]);
  const total = Number.parseInt(count.rows[0]?.total ?? '0', 10);
  return {
    items: items.rows,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      pages: Math.ceil(total / filters.limit),
    },
  };
}

export async function createApproval(
  workspaceId: string,
  userId: string,
  input: CreateApprovalInput
) {
  return withTransaction(async (client) => {
    const { rows } = await query<Approval>(
      `INSERT INTO approval_requests (
         workspace_id, requested_by, assigned_to, action_type, entity_type,
         entity_id, title, description, impact_amount, impact_currency,
         payload, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${approvalSelect}`,
      [
        workspaceId,
        userId,
        input.assignedTo ?? null,
        input.actionType,
        input.entityType ?? null,
        input.entityId ?? null,
        input.title,
        input.description ?? null,
        input.impactAmount ?? null,
        input.impactCurrency ?? null,
        input.payload ?? {},
        input.expiresAt ?? null,
      ],
      client,
    );
    const approval = rows[0];
    if (!approval) throw new Error('Approval insert did not return a row');
    await appendDomainEvent({
      workspaceId,
      type: DOMAIN_EVENT_TYPES.APPROVAL_REQUESTED,
      aggregateType: 'approval',
      aggregateId: approval.id,
      payload: { approvalId: approval.id, actionType: approval.actionType, status: approval.status },
      metadata: { actorId: userId, source: 'approvals' },
      idempotencyKey: `approval:${approval.id}:requested:v1`,
    }, client);
    return approval;
  });
}

export async function decideApproval(
  workspaceId: string,
  approvalId: string,
  userId: string,
  canDecideAll: boolean,
  input: DecideApprovalInput
) {
  const values: unknown[] = [workspaceId, approvalId, userId, input.decision, input.note ?? null];
  const assignmentCondition = canDecideAll ? '' : 'AND (assigned_to IS NULL OR assigned_to = $3)';
  return withTransaction(async (client) => {
    const { rows } = await query<Approval>(
      `UPDATE approval_requests
       SET status = $4, decision_note = $5, decided_by = $3, decided_at = NOW()
      WHERE workspace_id = $1 AND id = $2 AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (action_type NOT LIKE 'agent_%' OR EXISTS (
           SELECT 1 FROM workspace_members m JOIN users u ON u.id=m.user_id
           WHERE m.workspace_id=$1 AND m.user_id=$3 AND m.role IN ('owner','admin')
             AND u.verified_at IS NOT NULL AND u.deleted_at IS NULL
         ))
         ${assignmentCondition}
       RETURNING ${approvalSelect}`,
      values,
      client,
    );
    const approval = rows[0];
    if (approval) {
      await appendDomainEvent({
        workspaceId,
        type: DOMAIN_EVENT_TYPES.APPROVAL_DECIDED,
        aggregateType: 'approval',
        aggregateId: approval.id,
        payload: { approvalId: approval.id, actionType: approval.actionType, decision: approval.status },
        metadata: { actorId: userId, source: 'approvals' },
        idempotencyKey: `approval:${approval.id}:decided:${approval.status}:v1`,
      }, client);
    }
    return approval;
  });
}
