export type SubscriptionPlan = 'explorer' | 'viewer' | 'starter' | 'ai' | 'test';
export type AgentModule = 'general' | 'seo' | 'geo' | 'aeo' | 'website';

export type AgentCapabilities = {
  analyze: boolean;
  recommend: boolean;
  act: boolean;
  autonomous: boolean;
  automatic: boolean;
};

const exceptionModules = new Set<AgentModule>(['seo', 'geo', 'aeo', 'website']);

export function getAgentCapabilities(plan: SubscriptionPlan, module: AgentModule): AgentCapabilities {
  if (plan === 'explorer' || plan === 'viewer') return { analyze: false, recommend: false, act: false, autonomous: false, automatic: false };
  if (plan === 'ai' || plan === 'test') return { analyze: true, recommend: true, act: true, autonomous: true, automatic: true };
  const exception = exceptionModules.has(module);
  return { analyze: true, recommend: exception, act: exception, autonomous: exception, automatic: true };
}

export function isAgentModule(value: unknown): value is AgentModule {
  return value === 'general' || value === 'seo' || value === 'geo' || value === 'aeo' || value === 'website';
}
