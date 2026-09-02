import type { ResourceType } from '../../domain/resource-catalog.js';
import type { AgentModule } from './agent.capabilities.js';
import { modulesForResourceType } from './agent.domain.js';

// Cross-module reactions beyond the modules that naturally own a resource type.
// When one of these resources changes, the listed modules are woken up as well.
const EXTRA_REACTIONS: Partial<Record<ResourceType, AgentModule[]>> = {
  ecommerce_products: ['ai', 'marketing'],
  ai_knowledge: ['ai', 'commerce', 'marketing', 'crm', 'sales'],
  marketing_content: ['website', 'seo', 'geo', 'aeo'],
  crm_contacts: ['sales'],
  sales_leads: ['crm', 'marketing'],
  finance_invoices: ['sales'],
};

export function modulesReactingToResourceType(resourceType: string): AgentModule[] {
  const base = modulesForResourceType(resourceType as ResourceType);
  const extra = EXTRA_REACTIONS[resourceType as ResourceType] ?? [];
  return [...new Set([...base, ...extra])];
}
