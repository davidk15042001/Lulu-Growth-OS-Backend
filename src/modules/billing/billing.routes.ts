import { Router } from 'express';
import { handleWebhook, verifyWebhookSignature } from './airwallex.service.js';
import { successResponse } from '../../utils/response.js';
import { AppError } from '../../utils/app-error.js';

const router = Router();

router.post('/airwallex/webhook', async (req, res, next) => {
  try {
    const rawBody = (req as typeof req & { rawBody?: string }).rawBody;
    if (!rawBody) {
      throw new AppError(400, 'AIRWALLEX_RAW_BODY_MISSING', 'Airwallex webhook raw body is missing', { required: 'rawBody' });
    }
    verifyWebhookSignature(rawBody, req.header('x-timestamp') ?? undefined, req.header('x-signature') ?? undefined, req.header('x-nonce') ?? undefined);
    return successResponse(res, 'Airwallex webhook processed', await handleWebhook(req.body as Record<string, unknown>));
  } catch (error) {
    next(error);
  }
});

export default router;
