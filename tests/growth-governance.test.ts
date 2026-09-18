import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateGrowthGovernance, evaluateGrowthGovernanceSet, growthConflictKey } from '../src/modules/agents/growth-governance.js';

test('growth governance requires approval for external and financial mutations', () => {
  const result = evaluateGrowthGovernance('tenant-a', {
    type: 'website.publish_job', targetSystem: 'website', targetEntityType: 'site', targetEntityId: 'site-1', budgetAuthority: 'none',
  }, 'autonomous');
  assert.equal(result.decision, 'APPROVAL_REQUIRED');
  assert.equal(result.requiresHumanApproval, true);
  assert.equal(result.conflictKey, 'tenant-a:website:site:site-1');
});

test('budget authorization remains a distinct governance boundary', () => {
  const result = evaluateGrowthGovernance('tenant-a', {
    type: 'advertising.create_optimization', targetSystem: 'advertising', targetEntityType: 'campaign', targetEntityId: 'campaign-1', budgetAuthority: 'customer_authorization_required',
  }, 'autonomous');
  assert.equal(result.decision, 'BUDGET_REQUIRED');
  assert.equal(result.requiresHumanApproval, true);
});

test('conflict keys are tenant-scoped and governance aggregates conservatively', () => {
  const command = { type: 'social.content.publish' as const, targetSystem: 'marketing', targetEntityType: 'publication', targetEntityId: 'pub-1', budgetAuthority: 'none' as const };
  assert.notEqual(growthConflictKey('tenant-a', command), growthConflictKey('tenant-b', command));
  const result = evaluateGrowthGovernanceSet('tenant-a', [command, { ...command, type: 'record.create_artifact' }], 'analysis_only');
  assert.equal(result.requiresApproval, true);
  assert.equal(result.decision, 'APPROVAL_REQUIRED');
  assert.equal(result.conflictKeys.length, 1);
});
