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

  it('keeps invalid provider output as a stable safe error', () => {
    assert.throws(
      () => parseKnowledgeActivationJson('The model returned no JSON.'),
      (error: unknown) => error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'KNOWLEDGE_AI_RESPONSE_INVALID',
    );
  });
});
