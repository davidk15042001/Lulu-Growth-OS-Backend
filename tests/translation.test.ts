import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoundedTranslationCache } from '../src/modules/translations/translation.cache.js';
import { SUPPORTED_LANGUAGES } from '../src/modules/translations/translation.languages.js';
import {
  buildTranslationInstructions,
  translateStrings,
} from '../src/modules/translations/translation.service.js';
import type { ResponsesClient } from '../src/modules/ai/openai.service.js';

describe('translation service', () => {
  it('exposes every requested language', () => {
    assert.deepEqual(
      SUPPORTED_LANGUAGES.map((language) => language.code),
      ['en', 'de', 'zh-CN', 'fr', 'nl', 'pl', 'nb', 'sv', 'fi', 'da', 'ar', 'lb', 'mn', 'uk', 'ru']
    );
  });

  it('builds concise product-aware translation instructions', () => {
    const instructions = buildTranslationInstructions('de');
    assert.match(instructions, /German/);
    assert.match(instructions, /Lulu Intelligence/);
    assert.match(instructions, /same order/);
  });

  it('deduplicates, preserves order, and caches structured translations', async () => {
    const cache = new BoundedTranslationCache(100, 60_000);
    const requests: Record<string, unknown>[] = [];
    const client: ResponsesClient = {
      async create(params) {
        requests.push(params);
        return {
          id: 'resp_translation',
          model: 'gpt-test',
          output_text: JSON.stringify({
            translations: [
              { id: '0', text: 'Hallo' },
              { id: '1', text: 'Tschüss' },
            ],
          }),
        };
      },
      async createChat() {
        throw new Error('createChat should not be used by this test');
      },
    };

    const first = await translateStrings(
      {
        targetLanguage: 'de',
        strings: ['Hello', 'Hello', 'Goodbye'],
        requesterId: 'test-user',
      },
      { client, cache }
    );

    assert.deepEqual(first.translations, ['Hallo', 'Hallo', 'Tschüss']);
    assert.equal(first.generated, 2);
    assert.equal(first.cached, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.store, false);
    assert.equal((requests[0]?.text as { format?: { type?: string } }).format?.type, 'json_schema');

    const second = await translateStrings(
      {
        targetLanguage: 'de',
        strings: ['Goodbye', 'Hello'],
        requesterId: 'test-user',
      },
      { client, cache }
    );

    assert.deepEqual(second.translations, ['Tschüss', 'Hallo']);
    assert.equal(second.generated, 0);
    assert.equal(second.cached, 2);
    assert.equal(requests.length, 1);
  });

  it('returns English input without contacting the provider', async () => {
    const result = await translateStrings({
      targetLanguage: 'en',
      strings: ['Settings'],
      requesterId: 'test-user',
    });

    assert.deepEqual(result, { translations: ['Settings'], cached: 1, generated: 0 });
  });
});
