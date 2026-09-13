import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseBlockers } from './quality.policy.js';

const passedGate = { reviewerAgentId: 'gate', reviewerKind: 'final_gate', verdict: 'passed' };

test('quality release policy blocks incomplete provider results', () => {
  assert.deepEqual(releaseBlockers({
    reviews: [passedGate],
    findings: [],
    providerStatus: 'running',
    riskClass: 'standard',
    independentReviewRequired: false,
  }), ['provider_result_not_completed']);
});

test('quality release policy blocks unresolved hard findings', () => {
  assert.deepEqual(releaseBlockers({
    reviews: [passedGate],
    findings: [{ severity: 'hard_block', resolvedAt: null }],
    providerStatus: 'completed',
    riskClass: 'standard',
    independentReviewRequired: false,
  }), ['open_hard_block']);
});

test('regulated artifacts require two independent non-gate reviewers', () => {
  assert.deepEqual(releaseBlockers({
    reviews: [passedGate, { reviewerAgentId: 'reviewer-a', reviewerKind: 'evidence_claim', verdict: 'passed' }],
    findings: [],
    providerStatus: 'completed',
    riskClass: 'regulated',
    independentReviewRequired: false,
  }), ['independent_review_required']);
});

test('quality release policy allows a fully satisfied artifact', () => {
  assert.deepEqual(releaseBlockers({
    reviews: [passedGate, { reviewerAgentId: 'reviewer-a', reviewerKind: 'evidence_claim', verdict: 'passed' }, { reviewerAgentId: 'reviewer-b', reviewerKind: 'customer_reality', verdict: 'passed' }],
    findings: [{ severity: 'minor', resolvedAt: null }],
    providerStatus: 'completed',
    riskClass: 'high',
    independentReviewRequired: true,
  }), []);
});
