import { query, withTransaction } from '../../db/pool.js';
import { isResourceType, type ResourceType } from '../../domain/resource-catalog.js';
import { AppError, notFoundError } from '../../utils/app-error.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { assertWorkspaceCapability } from '../workspaces/workspace-authorization.service.js';
import { registerAgentActionPacket, type AgentExecutionIdentity } from './agent.authorization.js';
import type { AgentExecutionCommand } from './agent.execution-command.js';
import * as recordRepo from '../records/record.repo.js';

export type GrowthApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';

type ApprovalRow = {
  id: string;
  workspaceId: string;
  requestedBy: string | null;
  assignedTo: string | null;
  actionType: string;
  entityType: string | null;
  entityId: string | null;
  title: string;
  description: string | null;
  payload: Record<string, unknown>;
  status: GrowthApprovalStatus;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const select = `id, workspace_id AS "workspaceId", requested_by AS "requestedBy", assigned_to AS "assignedTo",
  action_type AS "actionType", entity_type AS "entityType", entity_id AS "entityId", title, description,
  payload, status, decision_note AS "decisionNote", decided_by AS "decidedBy", decided_at AS "decidedAt",
  expires_at AS "expiresAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\\d-]{36}$/i.test(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function createGrowthApproval(input: {
  workspaceId: string;
  requestedBy: string;
  title: string;
  description: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  expiresInHours?: number;
}) {
  await assertWorkspaceCapability({ workspaceId: input.workspaceId, userId: input.requestedBy, capability: 'agents.execute' });
  const expiresInHours = Math.max(1, Math.min(input.expiresInHours ?? 48, 168));
  const { rows } = await query<ApprovalRow>(
    `INSERT INTO approval_requests
      (workspace_id, requested_by, action_type, entity_type, entity_id, title, description, payload, expires_at)
     VALUES ($1,$2,'growth_agent_action',$3,$4,$5,$6,$7::jsonb,NOW()+($8::integer * INTERVAL '1 hour'))
     RETURNING ${select}`,
    [input.workspaceId, input.requestedBy, input.entityType, input.entityId, input.title.slice(0, 500), input.description.slice(0, 4_000), JSON.stringify(input.payload), expiresInHours],
  );
  const approval = rows[0];
  if (!approval) throw new AppError(500, 'APPROVAL_CREATE_FAILED', 'The approval request could not be created.');
  await query(
    `UPDATE workspace_records
        SET data = data || $3::jsonb, stage='waiting_approval', updated_at=NOW(), version=version+1
      WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`,
    [input.workspaceId, input.entityId, JSON.stringify({ approvalId: approval.id, approvalStatus: 'pending', executionReady: false, executionStatus: 'waiting_approval' })],
  );
  await recordSecurityEvent({ eventType: 'AGENT_APPROVAL_REQUESTED', workspaceId: input.workspaceId, userId: input.requestedBy, metadata: { action: 'growth_agent_action', targetId: input.entityId, approvalId: approval.id } });
  return approval;
}

export async function listGrowthApprovals(workspaceId: string, status: GrowthApprovalStatus | 'all' = 'pending') {
  const values: unknown[] = [workspaceId];
  const where = status === 'all' ? '' : 'AND status=$2';
  if (status !== 'all') values.push(status);
  const { rows } = await query<ApprovalRow>(`SELECT ${select} FROM approval_requests WHERE workspace_id=$1 AND action_type='growth_agent_action' ${where} ORDER BY created_at DESC LIMIT 100`, values);
  return rows;
}

async function getApproval(workspaceId: string, approvalId: string) {
  const { rows } = await query<ApprovalRow>(`SELECT ${select} FROM approval_requests WHERE workspace_id=$1 AND id=$2 AND action_type='growth_agent_action'`, [workspaceId, approvalId]);
  return rows[0] ?? null;
}

export async function decideGrowthApproval(input: { workspaceId: string; approvalId: string; actorId: string; decision: 'approve' | 'reject'; note?: string }) {
  await assertWorkspaceCapability({ workspaceId: input.workspaceId, userId: input.actorId, capability: 'agents.manage' });
  const approval = await getApproval(input.workspaceId, input.approvalId);
  if (!approval) throw notFoundError('Approval request not found');
  if (approval.status !== 'pending') throw new AppError(409, 'APPROVAL_ALREADY_DECIDED', 'This approval request is no longer pending.');
  if (approval.expiresAt && new Date(approval.expiresAt).getTime() <= Date.now()) {
    await query(`UPDATE approval_requests SET status='expired', updated_at=NOW() WHERE workspace_id=$1 AND id=$2 AND status='pending'`, [input.workspaceId, input.approvalId]);
    throw new AppError(409, 'APPROVAL_EXPIRED', 'This approval request has expired.');
  }

  const nextStatus: GrowthApprovalStatus = input.decision === 'approve' ? 'approved' : 'rejected';
  const decided = await withTransaction(async (client) => {
    const result = await query<ApprovalRow>(
      `UPDATE approval_requests
          SET status=$3, decision_note=$4, decided_by=$5, decided_at=NOW(), updated_at=NOW()
        WHERE workspace_id=$1 AND id=$2 AND status='pending'
        RETURNING ${select}`,
      [input.workspaceId, input.approvalId, nextStatus, input.note?.slice(0, 4_000) ?? null, input.actorId],
      client,
    );
    return result.rows[0] ?? null;
  });
  if (!decided) throw new AppError(409, 'APPROVAL_ALREADY_DECIDED', 'This approval request was decided concurrently.');

  const payload = objectValue(decided.payload);
  const recordId = typeof payload.recordId === 'string' ? payload.recordId : decided.entityId;
  const resourceType = typeof payload.resourceType === 'string' && isResourceType(payload.resourceType) ? payload.resourceType as ResourceType : null;
  if (recordId && resourceType && isUuid(recordId)) {
    if (nextStatus === 'rejected') {
      await query(`UPDATE workspace_records SET stage='cancelled', data=data || $3::jsonb, updated_at=NOW(), version=version+1 WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`, [input.workspaceId, recordId, JSON.stringify({ approvalStatus: 'rejected', executionReady: false, executionStatus: 'rejected', rejectionNote: input.note ?? null })]);
    } else {
      const record = await recordRepo.findRecord(input.workspaceId, resourceType, recordId);
      const identity = objectValue(payload.identity) as Partial<AgentExecutionIdentity>;
      const commands = Array.isArray(payload.commands) ? payload.commands as unknown as AgentExecutionCommand[] : [];
      if (!record || !isUuid(identity.userId) || !isUuid(identity.runId) || !isUuid(identity.stepId) || commands.length === 0) {
        throw new AppError(409, 'APPROVAL_RESUME_CONTEXT_MISSING', 'The approved action no longer has a valid execution context.');
      }
      await query(`UPDATE workspace_records SET stage='queued_for_execution', data=data || $3::jsonb, updated_at=NOW(), version=version+1 WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`, [input.workspaceId, recordId, JSON.stringify({ approvalStatus: 'approved', executionReady: true, executionStatus: 'queued', approvedBy: input.actorId, approvedAt: new Date().toISOString() })]);
      const refreshed = await recordRepo.findRecord(input.workspaceId, resourceType, recordId);
      if (!refreshed) throw new AppError(409, 'APPROVAL_RESUME_RECORD_MISSING', 'The approved action record no longer exists.');
      await registerAgentActionPacket({ workspaceId: input.workspaceId, userId: identity.userId, runId: identity.runId, stepId: identity.stepId }, refreshed, commands);
    }
  }
  await recordSecurityEvent({ eventType: input.decision === 'approve' ? 'AGENT_APPROVAL_APPROVED' : 'AGENT_APPROVAL_REJECTED', workspaceId: input.workspaceId, userId: input.actorId, metadata: { action: 'growth_agent_action', targetId: decided.entityId, approvalId: decided.id } });
  return decided;
}
