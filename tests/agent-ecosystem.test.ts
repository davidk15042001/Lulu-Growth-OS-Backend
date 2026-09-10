import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_REGISTRY_MINIMUM,
  agentRegistry,
  agentRegistrySummary,
  selectAgentTeam,
} from '../src/modules/agents/agent.ecosystem.js';

describe('agent ecosystem', () => {
  it('exposes more than 140 unique, structured agent definitions', () => {
    const summary = agentRegistrySummary();
    assert.ok(agentRegistry.length >= AGENT_REGISTRY_MINIMUM);
    assert.equal(new Set(agentRegistry.map((agent) => agent.id)).size, agentRegistry.length);
    assert.equal(summary.registeredAgents, agentRegistry.length);
    assert.ok(summary.systemAgents >= 10);
    assert.ok(summary.pageSpecialists >= 130);
    for (const agent of agentRegistry) {
      assert.ok(agent.capabilities.length > 0);
      assert.ok(agent.kpis.length > 0);
      assert.ok(agent.evaluationPolicy.length > 20);
      assert.ok(agent.recoveryBehavior.length > 20);
    }
  });

  it('selects a bounded cross-domain team instead of activating the entire registry', () => {
    const team = selectAgentTeam({
      connectedSignals: ['Google Ads', 'HubSpot CRM', 'Shopify'],
      resourceTypes: ['crm_contacts', 'finance_invoices', 'ecommerce_orders', 'ad_campaigns'],
      activity: [],
      maxSpecialists: 7,
      now: new Date('2026-09-10T00:00:00.000Z'),
    });

    assert.ok(team.specialists.length > 0);
    assert.ok(team.specialists.length <= 7);
    assert.ok(team.allAgents.length < agentRegistry.length);
    assert.ok(team.allAgents.some((entry) => entry.definition.id === 'system:executive-orchestrator'));
    assert.ok(team.allAgents.some((entry) => entry.definition.id === 'system:security-auditor'));
    assert.ok(team.allAgents.some((entry) => entry.definition.id === 'system:outcome-auditor'));
    const modules = new Set(team.specialists.map((entry) => entry.definition.module));
    assert.ok(modules.has('crm'));
    assert.ok(modules.has('finance'));
  });

  it('penalizes repeatedly selected weak agents so specialists can rotate', () => {
    const dashboardAgents = agentRegistry.filter((agent) => agent.tier === 'specialist' && agent.module === 'dashboard');
    const repeatedlySelected = dashboardAgents[0];
    assert.ok(repeatedlySelected?.pageId);
    const team = selectAgentTeam({
      connectedSignals: [],
      resourceTypes: [],
      activity: [{
        pageId: repeatedlySelected.pageId,
        lastStatus: 'completed',
        lastRunAt: '2026-09-10T00:00:00.000Z',
        performanceScore: 20,
        selectionCount: 20,
      }],
      maxSpecialists: 8,
      now: new Date('2026-09-10T01:00:00.000Z'),
    });
    assert.equal(team.specialists.some((entry) => entry.definition.id === repeatedlySelected.id), false);
  });
});
