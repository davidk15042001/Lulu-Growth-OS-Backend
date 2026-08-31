export type SubscriptionPlan = 'explorer' | 'viewer' | 'starter' | 'ai' | 'test';
export type AgentModule =
  | 'general'
  | 'dashboard'
  | 'intelligence'
  | 'finance'
  | 'sales'
  | 'crm'
  | 'ai'
  | 'email'
  | 'calendar'
  | 'marketing'
  | 'ads'
  | 'website'
  | 'commerce'
  | 'reputation'
  | 'settings'
  | 'seo'
  | 'geo'
  | 'aeo';

export type AgentCapabilities = {
  analyze: boolean;
  recommend: boolean;
  act: boolean;
  autonomous: boolean;
  automatic: boolean;
};

const specializedModules = new Set<AgentModule>([
  'dashboard',
  'intelligence',
  'finance',
  'sales',
  'crm',
  'ai',
  'email',
  'calendar',
  'marketing',
  'ads',
  'website',
  'commerce',
  'reputation',
  'settings',
  'seo',
  'geo',
  'aeo',
]);

export function getAgentCapabilities(plan: SubscriptionPlan, module: AgentModule): AgentCapabilities {
  if (plan === 'explorer' || plan === 'viewer') return { analyze: false, recommend: false, act: false, autonomous: false, automatic: false };
  if (plan === 'ai' || plan === 'test') return { analyze: true, recommend: true, act: true, autonomous: true, automatic: true };
  const specialized = specializedModules.has(module);
  return { analyze: true, recommend: specialized, act: specialized, autonomous: specialized, automatic: true };
}

export function isAgentModule(value: unknown): value is AgentModule {
  return value === 'general'
    || value === 'dashboard'
    || value === 'intelligence'
    || value === 'finance'
    || value === 'sales'
    || value === 'crm'
    || value === 'ai'
    || value === 'email'
    || value === 'calendar'
    || value === 'marketing'
    || value === 'ads'
    || value === 'website'
    || value === 'commerce'
    || value === 'reputation'
    || value === 'settings'
    || value === 'seo'
    || value === 'geo'
    || value === 'aeo';
}
