import type { AgentTool } from './agent.types.js';

export type AutonomyClass = 'AUTONOMOUS' | 'LIMITED_AUTONOMOUS' | 'USER_AUTHORIZATION_REQUIRED' | 'PROHIBITED';
export type AgentToolPolicyDecision = 'allow' | 'require_approval' | 'forbidden';
const classes: Readonly<Record<string,AutonomyClass>> = {
  'tool:agent.reason':'AUTONOMOUS',
  'tool:workspace_intelligence_snapshot':'AUTONOMOUS', 'tool:record_resource_snapshot':'AUTONOMOUS',
  'tool:email_operations_snapshot':'AUTONOMOUS', 'tool:calendar_operations_snapshot':'AUTONOMOUS',
  'tool:website_operations_snapshot':'AUTONOMOUS', 'tool:ai_workspace_snapshot':'AUTONOMOUS',
  'tool:reputation_snapshot':'AUTONOMOUS', 'tool:page_action_writeback':'LIMITED_AUTONOMOUS',
  'record.create_artifact':'AUTONOMOUS', 'crm.create_followup_task':'LIMITED_AUTONOMOUS',
  'sales.create_followup_task':'LIMITED_AUTONOMOUS', 'email.create_draft':'LIMITED_AUTONOMOUS',
  'email.create_ai_draft':'LIMITED_AUTONOMOUS', 'ecommerce.generate_product_images':'LIMITED_AUTONOMOUS',
  'finance.create_automation':'USER_AUTHORIZATION_REQUIRED', 'advertising.create_optimization':'USER_AUTHORIZATION_REQUIRED',
  'google_reviews.reply':'USER_AUTHORIZATION_REQUIRED', 'website.publish_job':'USER_AUTHORIZATION_REQUIRED',
};

/** A single, fail-closed classification shared by the runner and command worker.
 * Model-supplied flags can only raise risk; they can never grant authority. */
export function evaluateAgentActionPolicy(action: string, autonomous: boolean, options: { highRisk?: boolean; budgetProtected?: boolean } = {}) {
  let autonomyClass = classes[action] ?? 'PROHIBITED';
  if (autonomyClass !== 'PROHIBITED' && (options.highRisk || options.budgetProtected)) autonomyClass='USER_AUTHORIZATION_REQUIRED';
  const decision: AgentToolPolicyDecision = autonomyClass === 'PROHIBITED' ? 'forbidden'
    : autonomyClass === 'USER_AUTHORIZATION_REQUIRED' || (autonomyClass === 'LIMITED_AUTONOMOUS' && !autonomous) ? 'require_approval' : 'allow';
  return { autonomyClass, decision, reason: `${autonomyClass}: ${decision === 'forbidden' ? 'Action is not in the permitted backend registry.' : decision === 'require_approval' ? 'Explicit backend-verified human authorization is required.' : 'Action is permitted within the current entitlement and tenant context.'}` };
}

/** Legacy callers cannot authorize by passing approvalDecision='approved'. */
export function decideAgentToolPolicy(tool: AgentTool | undefined, autonomous: boolean, _approvalDecision: string | null): AgentToolPolicyDecision {
  return evaluateAgentActionPolicy(`tool:${tool?.name ?? 'agent.reason'}`,autonomous,{highRisk:tool?.risk==='external'||tool?.risk==='financial'||tool?.autonomy==='approval_required'}).decision;
}
