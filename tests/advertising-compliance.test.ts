import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAdsCompliance } from '../src/modules/advertising-compliance/advertising-compliance.service.js';

test('Ads Compliance Agent blocks incomplete launch evidence', () => {
  const result = evaluateAdsCompliance({ workspaceId: 'workspace', provider: 'google-ads', action: 'launch', context: {} });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'COUNTRY_REQUIRED'));
  assert.ok(result.findings.some((finding) => finding.code === 'LANDING_PAGE_REQUIRED'));
});

test('Ads Compliance Agent requires review for regulated European campaigns', () => {
  const result = evaluateAdsCompliance({
    workspaceId: 'workspace',
    provider: 'meta',
    action: 'publish',
    context: {
      countries: ['DE'],
      industry: 'financial services',
      adText: 'Learn about our business account',
      landingPageUrl: 'https://example.com',
      privacyPolicyUrl: 'https://example.com/privacy',
      consentMechanism: 'cookie-consent-v2',
      platformPolicyAcknowledged: true,
      specialAdCategory: 'CREDIT',
    },
  });
  assert.equal(result.decision, 'REVIEW_REQUIRED');
  assert.ok(result.findings.some((finding) => finding.code === 'REGULATED_INDUSTRY_REVIEW'));
});

test('Ads Compliance Agent passes evidence-backed low-risk campaigns', () => {
  const result = evaluateAdsCompliance({
    workspaceId: 'workspace',
    provider: 'linkedin-ads',
    action: 'launch',
    context: {
      countries: ['SG'],
      industry: 'industrial manufacturing',
      adText: 'Request a product consultation',
      landingPageUrl: 'https://example.com/request',
      platformPolicyAcknowledged: true,
    },
  });
  assert.equal(result.decision, 'PASSED');
  assert.equal(result.findings.length, 0);
});

test('Pausing a campaign is allowed without new creative evidence', () => {
  const result = evaluateAdsCompliance({ workspaceId: 'workspace', provider: 'google-ads', action: 'pause', context: {} });
  assert.equal(result.decision, 'PASSED');
});
