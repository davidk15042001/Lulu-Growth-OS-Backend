import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normaliseAiBusinessProfilePayload } from '../src/modules/onboarding/onboarding.ai-profile.service.js';

const suggestion = (value: string) => ({
  value,
  whyItFits: `${value} fits the available context.`,
  competitorGap: `${value} addresses a competitor gap.`,
  score: 90,
});

const rawProfile = () => ({
  summary: 'A grounded business profile.',
  recommendedProfile: {
    valueProposition: 'One clear promise.',
    vision: 'A durable, customer-led future.',
    targetMarket: 'Germany',
    primaryIcp: 'Industrial procurement leaders',
    usp: 'Verified export readiness',
    shortBrandDescription: 'A focused international growth platform.',
    primaryChallenges: ['Market entry'],
    languages: ['English'],
  },
  suggestions: {
    valuePropositions: [suggestion('One clear promise.'), suggestion('A discarded extra promise.')],
    visions: [suggestion('A durable, customer-led future.'), suggestion('A discarded extra vision.')],
    targetMarkets: ['Germany', 'United States', 'United Kingdom', 'France', 'Japan', 'Germany'].map(suggestion),
    primaryIcps: ['Industrial procurement leaders', 'Export managers', 'Operations directors'].map(suggestion),
    usps: ['Verified export readiness', 'Unified operations', 'Faster response'].map(suggestion),
    shortBrandDescriptions: ['Focused international growth', 'Structured expansion', 'Trusted automation'].map(suggestion),
    primaryChallenges: ['Market entry', 'Demand generation', 'Buyer response'].map(suggestion),
    languages: ['English', 'German', 'Chinese'].map(suggestion),
  },
  customerSegments: Array.from({ length: 20 }, (_, index) => ({
    name: `Segment ${index + 1}`,
    industry: 'Manufacturing',
    companySize: 'Mid-market',
    region: 'Europe',
    maturityLevel: 'Growing',
    painPoints: ['International demand'],
    jobsToBeDone: ['Expand exports'],
    decisionCriteria: ['Reliable delivery'],
    useCases: ['New market entry'],
    buyingRoles: ['Director'],
    priceSensitivity: 'Medium',
    primarySegment: index < 3,
    notes: null,
    score: 90 - index,
    whyItFits: 'Strong fit.',
  })),
  competitorComparison: [],
});

describe('AI business profile cardinality', () => {
  it('keeps one value proposition, one vision and five distinct target markets', () => {
    const payload = normaliseAiBusinessProfilePayload(
      rawProfile(),
      ['Competitor A', 'Competitor B', 'Competitor C', 'Competitor D', 'Competitor E'].map((name) => ({
        name,
        websiteUrl: null,
        competitorType: 'direct',
        market: 'Global',
        positioning: null,
        strengths: [],
        weaknesses: [],
        differentiators: [],
      })),
      [],
    );

    assert.equal(payload.suggestions.valuePropositions.length, 1);
    assert.equal(payload.suggestions.visions.length, 1);
    assert.equal(payload.suggestions.targetMarkets.length, 5);
    assert.deepEqual(payload.suggestions.targetMarkets.map((item) => item.value), ['Germany', 'United States', 'United Kingdom', 'France', 'Japan']);
    assert.equal(payload.recommendedProfile.vision, 'A durable, customer-led future.');
  });
});
