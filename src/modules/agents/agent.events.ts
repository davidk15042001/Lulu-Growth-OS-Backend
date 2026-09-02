import { EventEmitter } from 'node:events';

export type WorkspaceAgentEventType = 'record.created' | 'run.completed' | 'run.failed' | 'connected';

export type WorkspaceAgentEvent = {
  workspaceId: string;
  type: WorkspaceAgentEventType;
  resourceType?: string | null;
  recordId?: string | null;
  runId?: string | null;
  pageId?: string | null;
  payload?: Record<string, unknown>;
  occurredAt: string;
};

type Listener = (event: WorkspaceAgentEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(500);

export function publishAgentEvent(event: Omit<WorkspaceAgentEvent, 'occurredAt'>): WorkspaceAgentEvent {
  const full: WorkspaceAgentEvent = { ...event, occurredAt: new Date().toISOString() };
  emitter.emit('workspace-event', full);
  return full;
}

export function subscribeAgentEvents(listener: Listener): () => void {
  emitter.on('workspace-event', listener);
  return () => {
    emitter.off('workspace-event', listener);
  };
}
