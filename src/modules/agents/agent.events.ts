import { appendDomainEvent, latestWorkspaceDomainEventSequence, listWorkspaceDomainEvents } from '../../events/domain-event.repo.js';
import { subscribeDomainEvents } from '../../events/domain-event.runtime.js';
import { DOMAIN_EVENT_TYPES, type DomainEvent } from '../../events/domain-event.types.js';

export type WorkspaceAgentEventType = 'record.created' | 'run.completed' | 'run.failed' | 'connected';

export type WorkspaceAgentEvent = {
  id?: string;
  sequence?: string;
  workspaceId: string;
  type: WorkspaceAgentEventType;
  resourceType?: string | null;
  recordId?: string | null;
  runId?: string | null;
  pageId?: string | null;
  payload?: Record<string, unknown>;
  occurredAt: string;
};

const streamedEventTypes = [
  DOMAIN_EVENT_TYPES.RECORD_CREATED,
  DOMAIN_EVENT_TYPES.AGENT_RUN_COMPLETED,
  DOMAIN_EVENT_TYPES.AGENT_RUN_FAILED,
] as const;

function toWorkspaceAgentEvent(event: DomainEvent): WorkspaceAgentEvent | null {
  if (!event.workspaceId || !streamedEventTypes.includes(event.type as typeof streamedEventTypes[number])) return null;
  return {
    id: event.id,
    sequence: event.sequence,
    workspaceId: event.workspaceId,
    type: event.type as WorkspaceAgentEventType,
    resourceType: typeof event.payload.resourceType === 'string' ? event.payload.resourceType : null,
    recordId: typeof event.payload.recordId === 'string' ? event.payload.recordId : null,
    runId: typeof event.payload.runId === 'string' ? event.payload.runId : event.aggregateType === 'agent_run' ? event.aggregateId : null,
    pageId: typeof event.payload.pageId === 'string' ? event.payload.pageId : null,
    payload: event.payload,
    occurredAt: event.occurredAt,
  };
}

export async function publishAgentEvent(
  event: Omit<WorkspaceAgentEvent, 'id' | 'sequence' | 'occurredAt'>,
): Promise<WorkspaceAgentEvent> {
  const aggregateType = event.recordId ? 'workspace_record' : event.runId ? 'agent_run' : 'workspace';
  const aggregateId = event.recordId ?? event.runId ?? event.workspaceId;
  const persisted = await appendDomainEvent({
    workspaceId: event.workspaceId,
    type: event.type,
    aggregateType,
    aggregateId,
    payload: {
      ...(event.payload ?? {}),
      ...(event.resourceType ? { resourceType: event.resourceType } : {}),
      ...(event.recordId ? { recordId: event.recordId } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
      ...(event.pageId ? { pageId: event.pageId } : {}),
    },
    metadata: { source: 'agents' },
    ...(event.runId ? { idempotencyKey: `agent-run:${event.runId}:${event.type}:v1` } : {}),
  });
  return toWorkspaceAgentEvent(persisted)!;
}

export function subscribeAgentEvents(listener: (event: WorkspaceAgentEvent) => void): () => void {
  return subscribeDomainEvents((event) => {
    const mapped = toWorkspaceAgentEvent(event);
    if (mapped) listener(mapped);
  });
}

export async function listAgentEventsAfter(workspaceId: string, afterSequence = '0', limit = 200) {
  const events = await listWorkspaceDomainEvents(workspaceId, afterSequence, streamedEventTypes, limit);
  return events.flatMap((event) => {
    const mapped = toWorkspaceAgentEvent(event);
    return mapped ? [mapped] : [];
  });
}

export { latestWorkspaceDomainEventSequence };
