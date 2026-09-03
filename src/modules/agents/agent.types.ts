export const agentRoles = ['planner', 'analyst', 'strategist', 'executor', 'reviewer'] as const;
export type AgentRole = typeof agentRoles[number];
export const runStatuses = ['queued', 'planning', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'] as const;
export type AgentRunStatus = typeof runStatuses[number];
export const stepStatuses = ['pending', 'running', 'waiting_approval', 'completed', 'failed', 'skipped'] as const;
export type AgentStepStatus = typeof stepStatuses[number];

export type AgentRun = {
  id: string; workspaceId: string; createdBy: string | null; goal: string; status: AgentRunStatus;
  plan: Record<string, unknown>; result: Record<string, unknown> | null; errorCode: string | null;
  errorMessage: string | null; workerId: string | null; lockedAt: string | null; heartbeatAt: string | null;
  attemptCount: number; startedAt: string | null; finishedAt: string | null; createdAt: string; updatedAt: string;
};
export type AgentStep = {
  id: string; runId: string; workspaceId: string; sequenceNo: number; agentRole: AgentRole; title: string;
  instruction: string; status: AgentStepStatus; dependsOn: string[]; toolName: string | null;
  toolInput: Record<string, unknown> | null; toolOutput: Record<string, unknown> | null; approvalId: string | null;
  result: Record<string, unknown> | null; errorCode: string | null; errorMessage: string | null;
  startedAt: string | null; finishedAt: string | null; createdAt: string; updatedAt: string;
};
export type AgentRunEvent = {
  id: string; runId: string; stepId: string | null; workspaceId: string; eventType: string;
  agentRole: AgentRole | null; payload: Record<string, unknown>; createdAt: string;
};
export type AgentTool = {
  name: string; version: string; risk: 'read' | 'write' | 'external' | 'financial';
  autonomy: 'always_safe' | 'autonomous_only' | 'approval_required';
  description: string; execute: (input: Record<string, unknown>, context: { workspaceId: string; userId: string }) => Promise<Record<string, unknown>>;
};
