import { WORKSPACE_CAPABILITIES } from '../workspaces/workspace-permissions.js';

export const ENTITLEMENT_KEYS = [
  'website.enabled', 'workspace.write', 'website.managed_mode', 'ai.enabled', 'ai.autonomous_agents',
  'email.enabled', 'calendar.enabled', 'omnichannel.enabled', 'whatsapp.enabled',
  'advertising.google', 'advertising.meta', 'advertising.autopilot',
  'finance.buyer_payments', 'finance.payouts', 'partner_portal.enabled',
  'ai.monthly_usage_limit', 'workspace.max_users', 'website.max_sites', 'storage.max_bytes',
] as const;
export type EntitlementKey = typeof ENTITLEMENT_KEYS[number];
export type EntitlementSource = 'plan' | 'override' | 'restriction' | 'system_policy' | 'default';
export type EffectiveEntitlement = {
  key: EntitlementKey;
  enabled: boolean;
  limit: string | null;
  source: EntitlementSource;
  reason: string;
};

// Keep a compile-time relationship between the two registries visible to
// maintainers without making workspace permissions depend on plan pricing.
void WORKSPACE_CAPABILITIES;
