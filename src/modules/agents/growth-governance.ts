import type { AgentExecutionCommand, AgentExecutionCommandType } from './agent.execution-command.js';

export type GrowthGovernanceDecision = 'READ_ONLY' | 'PROPOSE_ONLY' | 'APPROVAL_REQUIRED' | 'BUDGET_REQUIRED' | 'AUTONOMOUS_ALLOWED';

export type GrowthGovernanceCommand = Pick<AgentExecutionCommand, 'type' | 'targetSystem' | 'targetEntityType' | 'targetEntityId' | 'budgetAuthority'>;

export type GrowthGovernanceResult = {
  decision: GrowthGovernanceDecision;
  requiresHumanApproval: boolean;
  reason: string;
  conflictKey: string;
};

const approvalRequired = new Set<AgentExecutionCommandType>([
  'advertising.create_optimization',
  'website.publish_job',
  'website.domain.verify',
  'google_reviews.reply',
  'email.send_draft',
  'omnichannel.send_message',
  'social.content.publish',
  'social.publication.retry',
  'finance.invoice.issue',
  'finance.invoice.send',
  'commerce.order.transition',
  'commerce.inventory.adjust',
]);

const readOnly = new Set<AgentExecutionCommandType>(['record.create_artifact']);

function safeSegment(value: unknown, fallback: string) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 180);
}

export function growthConflictKey(workspaceId: string, command: GrowthGovernanceCommand) {
  return [
    safeSegment(workspaceId, 'workspace'),
    safeSegment(command.targetSystem, 'system'),
    safeSegment(command.targetEntityType, 'entity'),
    safeSegment(command.targetEntityId, command.type),
  ].join(':');
}

export function evaluateGrowthGovernance(workspaceId: string, command: GrowthGovernanceCommand, mode: 'analysis_only' | 'autonomous'): GrowthGovernanceResult {
  const conflictKey = growthConflictKey(workspaceId, command);
  if (readOnly.has(command.type)) return { decision: 'READ_ONLY', requiresHumanApproval: false, reason: 'This command creates only an internal planning artifact.', conflictKey };
  if (command.budgetAuthority === 'customer_authorization_required') {
    return { decision: 'BUDGET_REQUIRED', requiresHumanApproval: true, reason: 'Customer-funded budget authorization is required before execution.', conflictKey };
  }
  if (approvalRequired.has(command.type)) {
    return { decision: 'APPROVAL_REQUIRED', requiresHumanApproval: true, reason: 'This external, financial, identity or publication action requires explicit human approval.', conflictKey };
  }
  if (mode === 'analysis_only') return { decision: 'PROPOSE_ONLY', requiresHumanApproval: false, reason: 'Analysis-only runs may propose but not execute mutations.', conflictKey };
  return { decision: 'AUTONOMOUS_ALLOWED', requiresHumanApproval: false, reason: 'The command is registered for bounded autonomous execution.', conflictKey };
}

export function evaluateGrowthGovernanceSet(workspaceId: string, commands: readonly GrowthGovernanceCommand[], mode: 'analysis_only' | 'autonomous') {
  const decisions = commands.map((command) => ({ commandType: command.type, ...evaluateGrowthGovernance(workspaceId, command, mode) }));
  const requiresApproval = decisions.some((entry) => entry.requiresHumanApproval);
  const conflictKeys = [...new Set(decisions.map((entry) => entry.conflictKey))];
  return {
    decisions,
    requiresApproval,
    conflictKeys,
    decision: requiresApproval ? 'APPROVAL_REQUIRED' as const : mode === 'analysis_only' ? 'PROPOSE_ONLY' as const : 'AUTONOMOUS_ALLOWED' as const,
  };
}
