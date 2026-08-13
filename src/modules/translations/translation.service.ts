import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import {
  buildSafetyIdentifier,
  getOpenAIResponsesClient,
  type ResponsesClient,
} from '../ai/openai.service.js';
import { translationCache, type TranslationCache } from './translation.cache.js';
import { getSupportedLanguage, type SupportedLanguageCode } from './translation.languages.js';
import { translationResponseSchema } from './translation.validator.js';

const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
} as const;

function cacheKey(targetLanguage: SupportedLanguageCode, source: string) {
  const digest = crypto.createHash('sha256').update(source).digest('hex');
  return `${targetLanguage}:${digest}`;
}

export function buildTranslationInstructions(targetLanguage: SupportedLanguageCode) {
  const target = getSupportedLanguage(targetLanguage);
  return [
    'You are the production UI translator for Lulu Growth OS.',
    `Translate every supplied English string into ${target.name} (${target.code}).`,
    'Preserve meaning, tone, capitalization intent, numbers, punctuation, whitespace-sensitive placeholders, URLs, email addresses, interpolation tokens, and keyboard shortcuts.',
    'Keep Lulu Intelligence, Lulu AI, company names, product names, platform names, and established technical acronyms unchanged unless they have a universally accepted localized form.',
    'Use concise, natural terminology appropriate for a modern business software interface.',
    'Return exactly one translation for every input id, in the same order. Do not add explanations.',
  ].join('\n');
}

export async function translateStrings(
  input: {
    targetLanguage: SupportedLanguageCode;
    strings: string[];
    requesterId: string;
  },
  dependencies: {
    client?: ResponsesClient;
    cache?: TranslationCache;
  } = {}
) {
  if (input.targetLanguage === 'en') {
    return { translations: input.strings, cached: input.strings.length, generated: 0 };
  }

  const cache = dependencies.cache ?? translationCache;
  const uniqueSources = [...new Set(input.strings)];
  const resolved = new Map<string, string>();
  const missing: string[] = [];

  for (const source of uniqueSources) {
    const cached = cache.get(cacheKey(input.targetLanguage, source));
    if (cached !== undefined) resolved.set(source, cached);
    else missing.push(source);
  }

  if (missing.length > 0) {
    const client = dependencies.client ?? getOpenAIResponsesClient();
    const response = await client.create({
      model: env.OPENAI_MODEL,
      instructions: buildTranslationInstructions(input.targetLanguage),
      input: JSON.stringify({
        targetLanguage: getSupportedLanguage(input.targetLanguage),
        strings: missing.map((text, index) => ({ id: String(index), text })),
      }),
      text: {
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'translation_batch',
          strict: true,
          schema: TRANSLATION_SCHEMA,
        },
      },
      reasoning: { effort: 'low' },
      max_output_tokens: env.OPENAI_MAX_OUTPUT_TOKENS,
      safety_identifier: buildSafetyIdentifier(`translation:${input.requesterId}`),
      store: false,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.output_text);
    } catch {
      throw new AppError(502, 'TRANSLATION_INVALID_RESPONSE', 'The translation provider returned invalid JSON');
    }

    const result = translationResponseSchema.safeParse(parsed);
    if (!result.success || result.data.translations.length !== missing.length) {
      throw new AppError(502, 'TRANSLATION_INVALID_RESPONSE', 'The translation provider returned an invalid batch');
    }

    result.data.translations.forEach((translation, index) => {
      if (translation.id !== String(index)) {
        throw new AppError(502, 'TRANSLATION_INVALID_RESPONSE', 'The translation provider returned mismatched ids');
      }
      const source = missing[index]!;
      const text = translation.text.trim();
      resolved.set(source, text);
      cache.set(cacheKey(input.targetLanguage, source), text);
    });
  }

  return {
    translations: input.strings.map((source) => resolved.get(source) ?? source),
    cached: uniqueSources.length - missing.length,
    generated: missing.length,
  };
}
