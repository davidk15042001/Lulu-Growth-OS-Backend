import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_REGISTRY_MINIMUM,
  agentRegistry,
  agentRegistrySummary,
  selectCollaboratingAgents,
  selectAgentTeam,
} from '../src/modules/agents/agent.ecosystem.js';
import {
  automaticPageProfiles,
  resolveAgentModule,
  sanitizeAgentPageContext,
} from '../src/modules/agents/agent.page-context.js';

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

  it('turns the selected team into a bounded set of relevant specialist collaborators', () => {
    const primary = agentRegistry.find((agent) => agent.tier === 'specialist' && agent.module === 'marketing');
    const website = agentRegistry.find((agent) => agent.tier === 'specialist' && agent.module === 'website');
    const finance = agentRegistry.find((agent) => agent.tier === 'specialist' && agent.module === 'finance');
    assert.ok(primary && website && finance);

    const collaborators = selectCollaboratingAgents({
      selectedAgentIds: [
        'system:executive-orchestrator',
        'system:security-auditor',
        primary.id,
        website.id,
        finance.id,
      ],
      primaryAgentId: primary.id,
      module: 'marketing',
    });

    assert.deepEqual(collaborators.map((agent) => agent.id), [website.id]);
  });

  it('uses capability ownership instead of legacy navigation grouping', () => {
    const sales = sanitizeAgentPageContext({ pageId: 'softly-autumn-9038' });
    const advertising = sanitizeAgentPageContext({ pageId: 'sunny-minute-1092' });
    const websitePost = sanitizeAgentPageContext({ pageId: 'website-posts-9016' });
    const integrations = sanitizeAgentPageContext({ pageId: 'glad-coast-1428' });
    assert.ok(sales && advertising && websitePost && integrations);
    assert.equal(resolveAgentModule('general', sales), 'sales');
    assert.equal(resolveAgentModule('general', advertising), 'ads');
    assert.equal(resolveAgentModule('general', websitePost), 'website');
    assert.equal(resolveAgentModule('general', integrations), 'settings');
  });

  it('uses the customer-facing CRM companies route as one operational employee', () => {
    const company = sanitizeAgentPageContext({ pageId: 'sturdy-month-1562' });
    assert.equal(company?.pageLabel, 'Companies');
    assert.equal(company?.agentName, 'Company Agent');
    assert.equal(automaticPageProfiles.some((profile) => profile.pageId === 'kindly-pool-8785'), false);
    assert.equal(agentRegistry.some((agent) => agent.pageId === 'kindly-pool-8785'), true);
  });

  it('prioritizes the canonical employee responsible for a source event', () => {
    const team = selectAgentTeam({
      connectedSignals: [],
      resourceTypes: [],
      activity: [],
      preferredModules: ['commerce'],
      preferredPageIds: ['mightily-shore-7108'],
      maxSpecialists: 8,
      now: new Date('2026-09-13T00:00:00.000Z'),
    });
    assert.ok(team.specialists.some((entry) => entry.definition.pageId === 'mightily-shore-7108'));
    const selected = team.specialists.find((entry) => entry.definition.pageId === 'mightily-shore-7108');
    assert.ok(selected?.reasons.includes('source event responsibility match'));
  });
});
