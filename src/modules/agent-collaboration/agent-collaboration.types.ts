export const agentCollaborationThreadStatuses = ['active', 'completed', 'failed', 'cancelled'] as const;
export type AgentCollaborationThreadStatus = typeof agentCollaborationThreadStatuses[number];

export const agentCollaborationMessageTypes = [
  'plan',
  'status',
  'evidence',
  'handoff',
  'proposal',
  'challenge',
  'decision',
  'action',
  'verification',
  'error',
] as const;
export type AgentCollaborationMessageType = typeof agentCollaborationMessageTypes[number];

export type AgentCollaborationThread = {
  id: string;
  workspaceId: string;
  runId: string;
  companyBrainTaskId: string | null;
  topic: string;
  status: AgentCollaborationThreadStatus;
  zepThreadId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentCollaborationMessage = {
  id: string;
  workspaceId: string;
  threadId: string;
  runId: string;
  stepId: string | null;
  senderType: 'agent' | 'system' | 'human';
  senderAgentId: string | null;
  recipientAgentId: string | null;
  messageType: AgentCollaborationMessageType;
  content: string;
  structuredContent: Record<string, unknown>;
  evidenceRefs: string[];
  confidence: number | null;
  idempotencyKey: string;
  zepSyncedAt: string | null;
  createdAt: string;
};

export type AgentCollaborationPage = {
  items: AgentCollaborationMessage[];
  nextBeforeMessageId: string | null;
};
