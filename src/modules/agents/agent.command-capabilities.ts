import type { WorkspaceCapability } from '../workspaces/workspace-permissions.js';
import type { AgentModule } from './agent.capabilities.js';
import type { AgentExecutionCommandType } from './agent.execution-command.js';

/**
 * Server-owned authorization boundary for executable agent commands.
 *
 * Model output, packet JSON and target-system labels are deliberately ignored:
 * only a registered command type determines the capability required for its
 * side effect.
 */
const COMMAND_CAPABILITY: Readonly<Record<AgentExecutionCommandType, WorkspaceCapability>> = Object.freeze({
  'record.create_artifact': 'workspace.write',
  'crm.company.enrich': 'crm.manage',
  'crm.company.sync': 'crm.manage',
  'crm.create_followup_task': 'crm.manage',
  'crm.transition_pipeline': 'crm.manage',
  'sales.create_followup_task': 'leads.manage',
  'sales.transition_pipeline': 'leads.manage',
  'sales.quote.create': 'quotes.create',
  'sales.quote.send': 'quotes.send',
  'advertising.create_optimization': 'advertising.manage',
  'finance.create_automation': 'finance.manage',
  'finance.invoice.create_from_order': 'invoices.create',
  'finance.invoice.issue': 'invoices.issue',
  'finance.invoice.send': 'invoices.send',
  'google_reviews.reply': 'omnichannel.reply',
  'email.create_draft': 'omnichannel.reply',
  'email.create_ai_draft': 'omnichannel.reply',
  'email.send_draft': 'omnichannel.reply',
  'omnichannel.send_message': 'omnichannel.reply',
  'calendar.event.create': 'workspace.write',
  'website.publish_job': 'website.publish',
  'website.generate_content': 'website.manage',
  'website.domain.verify': 'website.manage',
  'ecommerce.generate_product_images': 'products.update',
  'commerce.order.create': 'orders.manage',
  'commerce.order.update': 'orders.manage',
  'commerce.order.transition': 'orders.manage',
  'commerce.product.create': 'products.create',
  'commerce.product.update': 'products.update',
  'commerce.inventory.adjust': 'orders.manage',
  'commerce.fulfillment.create': 'orders.manage',
  'commerce.fulfillment.transition': 'orders.manage',
  'social.content.publish': 'social.publish',
  'social.publication.retry': 'social.publish',
  'social.publication.cancel': 'social.publish',
});

export function requiredCapabilityForAgentCommand(type: AgentExecutionCommandType) {
  const capability = COMMAND_CAPABILITY[type];
  if (!capability) throw new Error(`No workspace capability is registered for agent command ${String(type)}`);
  return capability;
}

export function requiredCapabilitiesForAgentCommands(types: readonly AgentExecutionCommandType[]) {
  return [...new Set(types.map(requiredCapabilityForAgentCommand))].sort();
}

const MODULE_SERVICE_CAPABILITIES: Readonly<Record<AgentModule, readonly WorkspaceCapability[]>> = Object.freeze({
  general: ['workspace.write'],
  dashboard: ['workspace.write'],
  intelligence: ['workspace.write'],
  finance: ['workspace.write', 'finance.manage', 'invoices.create'],
  sales: ['workspace.write', 'crm.manage', 'leads.manage', 'opportunities.manage', 'quotes.create', 'omnichannel.reply'],
  crm: ['workspace.write', 'crm.manage', 'leads.manage', 'opportunities.manage', 'omnichannel.reply'],
  ai: ['workspace.write'],
  email: ['workspace.write', 'omnichannel.reply'],
  calendar: ['workspace.write'],
  marketing: ['workspace.write', 'social.publish'],
  ads: ['workspace.write', 'advertising.manage'],
  website: ['workspace.write', 'website.manage', 'website.publish'],
  commerce: ['workspace.write', 'products.update', 'orders.manage'],
  reputation: ['workspace.write', 'omnichannel.reply'],
  settings: ['workspace.write', 'providers.manage'],
  seo: ['workspace.write', 'website.manage', 'website.publish'],
  geo: ['workspace.write', 'website.manage', 'website.publish'],
  aeo: ['workspace.write', 'website.manage', 'website.publish'],
});

/** Automatic runs receive this immutable-at-creation service scope. */
export function serviceCapabilityScopeForModule(module: AgentModule): WorkspaceCapability[] {
  return [...new Set<WorkspaceCapability>(['agents.execute', ...MODULE_SERVICE_CAPABILITIES[module]])].sort();
}
