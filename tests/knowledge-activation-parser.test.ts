import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseKnowledgeActivationJson } from '../src/modules/onboarding/knowledge-activation.parser.js';

describe('knowledge activation response parser', () => {
  it('accepts structured JSON wrapped in reasoning and markdown', () => {
    const result = parseKnowledgeActivationJson('<think>internal reasoning</think>\n```json\n{"summary":"Grounded","items":[],"generalKnowledge":[]}\n```');
    assert.equal(result.summary, 'Grounded');
  });

  it('extracts the first complete JSON object from provider prose', () => {
    const result = parseKnowledgeActivationJson('Here is the result:\n{"summary":"Grounded","nested":{"ok":true}}\nDone.');
    assert.deepEqual(result.nested, { ok: true });
  });

  it('unwraps provider envelopes around the knowledge object', () => {
    const result = parseKnowledgeActivationJson(JSON.stringify({
      result: { summary: 'Wrapped', items: [], generalKnowledge: [] },
    }));
    assert.equal(result.summary, 'Wrapped');
  });

  it('accepts a top-level item array as provider output', () => {
    const result = parseKnowledgeActivationJson('[{"name":"Consulting","kind":"service"}]');
    assert.deepEqual(result.items, [{ name: 'Consulting', kind: 'service' }]);
  });

  it('extracts nested text from response content arrays', () => {
    const result = parseKnowledgeActivationJson(JSON.stringify([
      { type: 'output_text', text: '{"summary":"Nested text","items":[]}' },
    ]));
    assert.equal(result.summary, 'Nested text');
  });

  it('returns an empty classification for invalid provider output', () => {
    assert.deepEqual(parseKnowledgeActivationJson('The model returned no JSON.'), {});
  });
});
