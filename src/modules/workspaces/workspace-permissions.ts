/**
 * Canonical workspace authorization vocabulary.
 *
 * Keep this registry independent from UI labels and commercial plans. Roles are
 * a convenient assignment mechanism; the policy decision is always made from
 * capabilities so autonomous actors can use the same contract later.
 */
export const WORKSPACE_CAPABILITIES = [
  'workspace.read', 'workspace.write', 'workspace.manage',
  'members.read', 'members.invite', 'members.manage', 'members.remove',
  'products.read', 'products.create', 'products.update', 'products.delete',
  'crm.read', 'crm.manage', 'leads.read', 'leads.manage',
  'opportunities.read', 'opportunities.manage',
  'quotes.read', 'quotes.create', 'quotes.update', 'quotes.send', 'quotes.approve',
  'invoices.read', 'invoices.create', 'invoices.issue', 'invoices.send', 'invoices.cancel',
  'commercial_policy.read', 'commercial_policy.manage',
  'orders.read', 'orders.manage', 'website.read', 'website.manage',
  'website.publish', 'omnichannel.read', 'omnichannel.reply', 'omnichannel.manage',
  'advertising.read', 'advertising.manage', 'advertising.budget_authorize',
  'finance.read', 'finance.manage', 'payouts.request', 'payouts.manage',
  'providers.read', 'providers.connect', 'providers.manage',
  'agents.read', 'agents.manage', 'agents.execute',
  'settings.read', 'settings.manage', 'audit.read',
] as const;

export type WorkspaceCapability = typeof WORKSPACE_CAPABILITIES[number];
export type WorkspaceActorType = 'USER' | 'AI_AGENT' | 'WORKFLOW' | 'SYSTEM' | 'ADMIN';
export type WorkspaceRole =
  | 'owner' | 'admin' | 'sales_manager' | 'sales_user' | 'marketing_manager'
  | 'marketing_user' | 'finance_manager' | 'operations_manager' | 'member' | 'viewer';

const all = new Set<WorkspaceCapability>(WORKSPACE_CAPABILITIES);
const readOnly = new Set<WorkspaceCapability>([
  'workspace.read', 'members.read', 'products.read', 'crm.read', 'leads.read',
  'opportunities.read', 'quotes.read', 'invoices.read', 'orders.read', 'website.read',
  'omnichannel.read', 'advertising.read', 'finance.read', 'providers.read',
  'agents.read', 'settings.read', 'audit.read',
]);

/** Fallback used during a rolling deployment before the registry migration is visible. */
export const ROLE_CAPABILITIES: Record<WorkspaceRole, ReadonlySet<WorkspaceCapability>> = {
  owner: all,
  admin: all,
  member: new Set([
    'workspace.read', 'workspace.write', 'members.read', 'products.read', 'products.create',
    'products.update', 'crm.read', 'crm.manage', 'leads.read', 'leads.manage',
    'opportunities.read', 'opportunities.manage', 'quotes.read', 'quotes.create', 'quotes.send',
    'orders.read', 'orders.manage', 'website.read', 'website.manage', 'omnichannel.read',
    'omnichannel.reply', 'advertising.read', 'finance.read', 'agents.read', 'agents.execute',
    'settings.read',
  ]),
  viewer: readOnly,
  sales_manager: new Set(['workspace.read','workspace.write','members.read','products.read','crm.read','crm.manage','leads.read','leads.manage','opportunities.read','opportunities.manage','quotes.read','quotes.create','quotes.update','quotes.send','invoices.read','invoices.create','invoices.send','orders.read','orders.manage','omnichannel.read','omnichannel.reply','settings.read']),
  sales_user: new Set(['workspace.read','workspace.write','members.read','products.read','crm.read','leads.read','leads.manage','opportunities.read','quotes.read','quotes.create','quotes.update','quotes.send','invoices.read','invoices.create','invoices.send','orders.read','omnichannel.read','omnichannel.reply','settings.read']),
  marketing_manager: new Set(['workspace.read','workspace.write','members.read','products.read','website.read','website.manage','website.publish','advertising.read','advertising.manage','advertising.budget_authorize','omnichannel.read','agents.read','settings.read']),
  marketing_user: new Set(['workspace.read','workspace.write','members.read','products.read','website.read','advertising.read','omnichannel.read','agents.read','settings.read']),
  finance_manager: new Set(['workspace.read','members.read','finance.read','finance.manage','invoices.read','invoices.create','invoices.issue','invoices.send','invoices.cancel','commercial_policy.read','commercial_policy.manage','payouts.request','payouts.manage','orders.read','settings.read']),
  operations_manager: new Set(['workspace.read','workspace.write','members.read','products.read','products.create','products.update','orders.read','orders.manage','website.read','website.manage','providers.read','settings.read']),
};

export function isWorkspaceCapability(value: string): value is WorkspaceCapability {
  return (all as Set<string>).has(value);
}

export function roleCan(role: string, capability: WorkspaceCapability) {
  return Boolean(ROLE_CAPABILITIES[role as WorkspaceRole]?.has(capability));
}

const roleRank: Record<WorkspaceRole, number> = {
  viewer: 10, sales_user: 20, marketing_user: 20, member: 20,
  sales_manager: 30, marketing_manager: 30, finance_manager: 30,
  operations_manager: 30, admin: 40, owner: 50,
};

export function canGrantRole(actorRole: string, targetRole: WorkspaceRole) {
  const actor = roleRank[actorRole as WorkspaceRole];
  const target = roleRank[targetRole];
  return actor !== undefined && target !== undefined && actor >= target && targetRole !== 'owner';
}

export function canTransferOwnership(actorRole: string) {
  return actorRole === 'owner';
}
