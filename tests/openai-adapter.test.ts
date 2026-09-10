import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { env } from '../src/config/env.js';
import {
  buildAssistantInstructions,
  buildSafetyIdentifier,
  classifyAiProviderFailure,
  generateAssistantResponse,
  isAiProviderFailoverError,
  type ResponsesClient,
} from '../src/modules/ai/openai.service.js';

const context = {
  company: {
    name: 'Acme GmbH',
    industry: 'B2B SaaS',
    businessDescription: 'Revenue intelligence software',
    valueProposition: 'Clear next actions',
    targetMarket: 'European growth teams',
  },
  preferences: {
    priorities: ['Revenue Growth'],
    communicationStyle: 'concise',
    insightDetail: 'standard',
    responseLanguage: 'de',
    actionLevel: 'advisory',
  },
};

describe('OpenAI Responses adapter', () => {
  it('builds bounded instructions with company and prepaid-budget context', () => {
    const instructions = buildAssistantInstructions(context);
    assert.match(instructions, /Acme GmbH/);
    assert.match(instructions, /only customer authorization boundary is adding prepaid paid-media budget/);
    assert.match(instructions, /advisory/);
  });

  it('creates a stable privacy-preserving safety identifier', () => {
    const first = buildSafetyIdentifier('user-123');
    const second = buildSafetyIdentifier('user-123');
    assert.equal(first, second);
    assert.equal(first.length, 64);
    assert.notEqual(first, 'user-123');
  });

  it('fails over for provider-specific failures that another configured provider can recover from',()=>{
    assert.equal(isAiProviderFailoverError({status:401}),true);
    assert.equal(isAiProviderFailoverError({status:402}),true);
    assert.equal(isAiProviderFailoverError({status:404}),true);
    assert.equal(isAiProviderFailoverError({status:422}),true);
    assert.equal(isAiProviderFailoverError({status:429}),true);
    assert.equal(isAiProviderFailoverError({name:'APIConnectionError'}),true);
    assert.equal(isAiProviderFailoverError({status:400}),true);
  });

  it('classifies provider failures without exposing response bodies',()=>{
    assert.equal(classifyAiProviderFailure({status:401}),'authentication');
    assert.equal(classifyAiProviderFailure({status:402}),'insufficient_balance');
    assert.equal(classifyAiProviderFailure({status:404}),'model_unavailable');
    assert.equal(classifyAiProviderFailure({status:429}),'rate_limited');
    assert.equal(classifyAiProviderFailure({status:503}),'upstream');
    assert.equal(classifyAiProviderFailure({name:'APIConnectionError'}),'network');
  });

  it('sends a non-persisted Responses API request and maps usage', async () => {
    let captured: Record<string, unknown> | undefined;
    const client: ResponsesClient = {
      async create(params) {
        captured = params;
        return {
          id: 'resp_test',
          model: 'gpt-test',
          output_text: '  A grounded answer.  ',
          usage: { input_tokens: 12, output_tokens: 7 },
        };
      },
      async createChat() {
        throw new Error('createChat should not be used by this test');
      },
    };

    const result = await generateAssistantResponse(
      {
        userId: 'user-123',
        model: 'gpt-test',
        context,
        turns: [{ role: 'user', content: 'What should we do next?' }],
      },
      client
    );

    assert.equal(captured?.store, false);
    assert.equal(captured?.model, 'gpt-test');
    if (env.AI_PROVIDER === 'openai') assert.equal(typeof captured?.safety_identifier, 'string');
    else assert.equal(captured?.safety_identifier, undefined);
    assert.equal(result.content, 'A grounded answer.');
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7 });
  });
});
