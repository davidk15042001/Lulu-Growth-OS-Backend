import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GROWTH_AGENT_CONTRACTS,
  canGrowthAgentUseProvider,
  getGrowthAgentContract,
  growthActionRequiresApproval,
} from '../src/modules/agents/growth-operating-model.js';

test('growth operating model contains every master-prompt agent exactly once', () => {
  assert.equal(GROWTH_AGENT_CONTRACTS.length, 24);
  assert.equal(new Set(GROWTH_AGENT_CONTRACTS.map((agent) => agent.id)).size, 24);
  assert.ok(getGrowthAgentContract('market_research'));
  assert.ok(getGrowthAgentContract('qa_audit_rollback'));
});

test('research and creative providers stay separated by agent contract', () => {
  assert.equal(canGrowthAgentUseProvider('market_research', 'perplexity'), true);
  assert.equal(canGrowthAgentUseProvider('market_research', 'firecrawl'), true);
  assert.equal(canGrowthAgentUseProvider('market_research', 'higgsfield'), false);
  assert.equal(canGrowthAgentUseProvider('creative', 'higgsfield'), true);
  assert.equal(canGrowthAgentUseProvider('creative', 'firecrawl'), true);
});

test('write and identity actions require approval by default', () => {
  assert.equal(growthActionRequiresApproval('search_ads', 'execute'), true);
  assert.equal(growthActionRequiresApproval('search_ads', 'financial'), true);
  assert.equal(growthActionRequiresApproval('reporting', 'read'), false);
  assert.equal(growthActionRequiresApproval('unknown-agent', 'execute'), true);
});
