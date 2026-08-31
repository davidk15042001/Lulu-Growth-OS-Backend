import type { AgentTool } from './agent.types.js';

export type AgentToolPolicyDecision = 'allow' | 'require_approval';

export function decideAgentToolPolicy(tool: AgentTool | undefined, autonomous: boolean, approvalDecision: string | null): AgentToolPolicyDecision {
  if (!tool) return 'allow';
  if (approvalDecision === 'approved') return 'allow';
  if (tool.risk === 'read') return 'allow';
  if (tool.autonomy === 'always_safe') return 'allow';
  if (tool.autonomy === 'autonomous_only' && autonomous) return 'allow';
  return 'require_approval';
}
