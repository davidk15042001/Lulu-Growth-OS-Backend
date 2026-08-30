import { Router } from 'express';
import type { Request } from 'express';
import { env } from '../../config/env.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import { dbRateLimit } from '../../middlewares/rateLimit.middleware.js';
import * as controller from './translation.controller.js';

const router = Router();
const rateLimitMessage = 'Translation quota exceeded. Please wait before requesting more translations.';
function translationCharacterCost(req: Request) {
  const body = req.body as { strings?: unknown; targetLanguage?: unknown } | undefined;
  if (body?.targetLanguage === 'en') return 1;
  const strings = body?.strings;
  if (!Array.isArray(strings)) return 1;
  return strings.reduce((total, value) => total + (typeof value === 'string' ? value.length : 1), 0);
}
const translationRequestLimiter = dbRateLimit({
  keyPrefix: 'translations-requests',
  windowMs: 60 * 1000,
  limit: 20,
  message: rateLimitMessage,
});
const translationCharacterLimiter = dbRateLimit({
  keyPrefix: 'translations-characters',
  windowMs: 60 * 60 * 1000,
  limit: 200_000,
  message: rateLimitMessage,
  cost: translationCharacterCost,
});
const translationGlobalCharacterLimiter = dbRateLimit({
  keyPrefix: 'translations-global-characters',
  windowMs: 60 * 60 * 1000,
  limit: env.TRANSLATION_GLOBAL_CHARACTER_LIMIT_PER_HOUR,
  message: rateLimitMessage,
  identifier: () => 'global',
  cost: translationCharacterCost,
});

router.route('/')
  .post(
    translationRequestLimiter,
    translationCharacterLimiter,
    translationGlobalCharacterLimiter,
    controller.translate,
  )
  .all(methodNotAllowed);

export default router;
