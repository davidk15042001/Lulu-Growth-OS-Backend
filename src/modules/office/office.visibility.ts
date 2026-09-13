import type { WorkspaceCapability } from '../workspaces/workspace-permissions.js';
import { isWorkspaceCapability } from '../workspaces/workspace-permissions.js';
import type { OfficeEmployeeRow, OfficeTimelineItem, OfficeWorkItem } from './office.types.js';

export type OfficeActorAccess = {
  capabilities: ReadonlySet<WorkspaceCapability>;
};

const aggregateCapabilities: ReadonlyArray<[RegExp, WorkspaceCapability]> = [
  [/^(invoice|invoice_payment)$/i, 'invoices.read'],
  [/^(quote|quotation)$/i, 'quotes.read'],
  [/^(journal|journal_entry|ledger|finance|billing|api_wallet|workspace_subscription|billing_scheduler)$/i, 'finance.read'],
  [/^(ad_|advertising|campaign)/i, 'advertising.read'],
  [/^(order|commerce_order|inventory|fulfillment)/i, 'orders.read'],
  [/^(product|category|premium_media)/i, 'products.read'],
  [/^(company|customer|crm)/i, 'crm.read'],
  [/^lead/i, 'leads.read'],
  [/^opportunit/i, 'opportunities.read'],
  [/^(conversation|message|channel_identity|website_chat|routing_queue|email)/i, 'omnichannel.read'],
  [/^(social_account|social_content|social_publication)/i, 'social.read'],
  [/^(website|page|post|review|content_refresh)/i, 'website.read'],
  [/^(provider|integration)/i, 'providers.read'],
  [/^(agent|office_work_item)/i, 'agents.read'],
  [/^(workspace|calendar|metric|notification)/i, 'workspace.read'],
];

const resourceCapabilities: ReadonlyArray<[RegExp, WorkspaceCapability]> = [
  [/(invoice)/i, 'invoices.read'],
  [/(payment|finance|billing|bookkeep|ledger|journal)/i, 'finance.read'],
  [/(quote|quotation)/i, 'quotes.read'],
  [/(order|inventory|fulfillment)/i, 'orders.read'],
  [/(product|catalog|category|media)/i, 'products.read'],
  [/(lead)/i, 'leads.read'],
  [/(opportunit)/i, 'opportunities.read'],
  [/(company|customer|crm)/i, 'crm.read'],
  [/(conversation|message|email|omnichannel|channel)/i, 'omnichannel.read'],
  [/(social|marketing_content|publication)/i, 'social.read'],
  [/(campaign|advertis|ad_spend|ad_budget)/i, 'advertising.read'],
  [/(website|page|post|review|content)/i, 'website.read'],
  [/(provider|integration)/i, 'providers.read'],
  [/(agent|approval)/i, 'agents.read'],
];

function matchingCapability(value: string, mappings: ReadonlyArray<[RegExp, WorkspaceCapability]>) {
  return mappings.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}

export function requiredTimelineCapability(item: Pick<OfficeTimelineItem, 'type' | 'aggregateType' | 'payload'>) {
  const aggregateType = item.aggregateType?.trim() ?? '';
  if (aggregateType === 'document_delivery') {
    return item.type.startsWith('quote.') ? 'quotes.read' : 'invoices.read';
  }
  if (aggregateType === 'workspace_record') {
    const resourceType = typeof item.payload.resourceType === 'string' ? item.payload.resourceType : '';
    return matchingCapability(resourceType, resourceCapabilities) ?? 'audit.read';
  }
  const aggregateMatch = matchingCapability(aggregateType, aggregateCapabilities);
  if (aggregateMatch) return aggregateMatch;
  const typeMatch = matchingCapability(item.type, aggregateCapabilities)
    ?? matchingCapability(item.type, resourceCapabilities);
  return typeMatch ?? 'audit.read';
}

export function requiredWorkItemCapability(item: Pick<OfficeWorkItem, 'relatedObjectType'>) {
  if (!item.relatedObjectType) return null;
  return matchingCapability(item.relatedObjectType, aggregateCapabilities)
    ?? matchingCapability(item.relatedObjectType, resourceCapabilities)
    ?? 'audit.read';
}

export function canSeeEmployee(row: Pick<OfficeEmployeeRow, 'readCapabilityKeys'>, access: OfficeActorAccess) {
  if (row.readCapabilityKeys.length === 0) return access.capabilities.has('audit.read');
  return row.readCapabilityKeys.every((key) => isWorkspaceCapability(key) && access.capabilities.has(key));
}

export function canSeeWorkItem(
  item: Pick<OfficeWorkItem, 'relatedObjectType'>,
  access: OfficeActorAccess,
) {
  const capability = requiredWorkItemCapability(item);
  return capability === null || access.capabilities.has(capability);
}

export function canSeeTimelineItem(item: OfficeTimelineItem, access: OfficeActorAccess) {
  return access.capabilities.has(requiredTimelineCapability(item));
}

const safePayloadKeys = new Set(['status', 'direction', 'action', 'sourceType', 'trigger']);
const safeTextPayloadKeys = new Set(['status', 'direction', 'action', 'sourceType', 'trigger']);
const safeSummaryToken = /^[A-Za-z0-9_.:-]{1,80}$/;

export function redactTimelineItem(item: OfficeTimelineItem): OfficeTimelineItem {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item.payload ?? {})) {
    if (!safePayloadKeys.has(key)) continue;
    if (typeof value === 'string' && safeTextPayloadKeys.has(key) && safeSummaryToken.test(value)) payload[key] = value;
    else if (typeof value === 'boolean' || value === null) payload[key] = value;
  }
  return { ...item, payload };
}

export function redactWorkItem<T extends OfficeWorkItem>(item: T): T {
  return {
    ...item,
    context: {},
    result: null,
    errorMessage: item.errorCode ? 'Operation failed; inspect the canonical workspace object for details.' : null,
  };
}
