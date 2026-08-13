import { z } from 'zod';
import { SUPPORTED_LANGUAGE_CODES } from './translation.languages.js';

const MAX_BATCH_CHARACTERS = 20_000;

export const translateSchema = z
  .object({
    sourceLanguage: z.literal('en').default('en'),
    targetLanguage: z.enum(SUPPORTED_LANGUAGE_CODES),
    strings: z.array(z.string().trim().min(1).max(1_000)).min(1).max(60),
  })
  .superRefine((value, context) => {
    const characters = value.strings.reduce((total, item) => total + item.length, 0);
    if (characters > MAX_BATCH_CHARACTERS) {
      context.addIssue({
        code: 'custom',
        path: ['strings'],
        message: `Translation batches may contain at most ${MAX_BATCH_CHARACTERS} characters`,
      });
    }
  });

export const translationResponseSchema = z.object({
  translations: z.array(
    z.object({
      id: z.string(),
      text: z.string().min(1),
    })
  ),
});
