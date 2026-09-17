import type { AgentTool } from './agent.types.js';

export type AutonomyClass = 'AUTONOMOUS' | 'LIMITED_AUTONOMOUS' | 'USER_AUTHORIZATION_REQUIRED' | 'PROHIBITED';
export type AgentToolPolicyDecision = 'allow' | 'require_budget' | 'forbidden';
const classes: Readonly<Record<string,AutonomyClass>> = {
  'tool:agent.reason':'AUTONOMOUS',
  'tool:workspace_intelligence_snapshot':'AUTONOMOUS', 'tool:record_resource_snapshot':'AUTONOMOUS',
  'tool:email_operations_snapshot':'AUTONOMOUS', 'tool:calendar_operations_snapshot':'AUTONOMOUS',
  'tool:website_operations_snapshot':'AUTONOMOUS', 'tool:ai_workspace_snapshot':'AUTONOMOUS',
  'tool:reputation_snapshot':'AUTONOMOUS', 'tool:page_action_writeback':'AUTONOMOUS',
  'record.create_artifact':'AUTONOMOUS', 'crm.create_followup_task':'AUTONOMOUS', 'crm.transition_pipeline':'AUTONOMOUS',
  'sales.create_followup_task':'AUTONOMOUS', 'sales.transition_pipeline':'AUTONOMOUS', 'sales.quote.create':'AUTONOMOUS', 'sales.quote.send':'AUTONOMOUS', 'email.create_draft':'AUTONOMOUS',
  'email.create_ai_draft':'AUTONOMOUS', 'ecommerce.generate_product_images':'AUTONOMOUS',
  'email.send_draft':'AUTONOMOUS',
  'finance.create_automation':'AUTONOMOUS', 'advertising.create_optimization':'AUTONOMOUS',
  'finance.invoice.create_from_order':'AUTONOMOUS', 'finance.invoice.issue':'AUTONOMOUS', 'finance.invoice.send':'AUTONOMOUS',
  'google_reviews.reply':'AUTONOMOUS', 'website.publish_job':'AUTONOMOUS',
  'omnichannel.send_message':'AUTONOMOUS', 'calendar.event.create':'AUTONOMOUS', 'workspace.refresh':'AUTONOMOUS',
  'commerce.order.create':'AUTONOMOUS', 'commerce.order.update':'AUTONOMOUS',
  'commerce.order.transition':'AUTONOMOUS', 'commerce.inventory.adjust':'AUTONOMOUS',
  'commerce.product.create':'AUTONOMOUS', 'commerce.product.update':'AUTONOMOUS',
  'commerce.fulfillment.create':'AUTONOMOUS', 'commerce.fulfillment.transition':'AUTONOMOUS',
  'social.content.publish':'AUTONOMOUS', 'social.publication.retry':'AUTONOMOUS',
  'social.publication.cancel':'AUTONOMOUS',
};

/** A single, fail-closed classification shared by the runner and command worker.
 * Model-supplied flags can only raise risk; they can never grant authority. */
export function evaluateAgentActionPolicy(action: string, autonomous: boolean, options: { highRisk?: boolean; budgetProtected?: boolean } = {}) {
  let autonomyClass = classes[action] ?? 'PROHIBITED';
  // Risk is controlled by backend capabilities, idempotency and provider limits.
  // New budget is authorized by the customer funding the prepaid wallet. It is
  // never represented as a per-action human approval inside the agent runtime.
  if (autonomyClass !== 'PROHIBITED' && options.budgetProtected) autonomyClass='USER_AUTHORIZATION_REQUIRED';
  const decision: AgentToolPolicyDecision = autonomyClass === 'PROHIBITED' ? 'forbidden'
    : autonomyClass === 'USER_AUTHORIZATION_REQUIRED' ? 'require_budget'
      : autonomyClass === 'LIMITED_AUTONOMOUS' && !autonomous ? 'forbidden' : 'allow';
  return { autonomyClass, decision, reason: `${autonomyClass}: ${decision === 'forbidden' ? 'Action is not in the permitted backend registry.' : decision === 'require_budget' ? 'Customer-funded prepaid budget is required.' : 'Action is permitted within the current entitlement and tenant context.'}` };
}

/** Legacy callers cannot authorize by passing approvalDecision='approved'. */
export function decideAgentToolPolicy(tool: AgentTool | undefined, autonomous: boolean, _approvalDecision: string | null): AgentToolPolicyDecision {
  return evaluateAgentActionPolicy(`tool:${tool?.name ?? 'agent.reason'}`,autonomous).decision;
}
