import type { AgentModule } from './agent.capabilities.js';

/**
 * AI funding enables the general autonomous runtime. Paid advertising has a
 * second, independent wallet and is the only module gated by ad-spend funds.
 */
export function canRunAutomaticallyWithFunding(module: AgentModule, adSpendFunded: boolean) {
  return module !== 'ads' || adSpendFunded;
}
