import type { NextFunction, Request, Response } from 'express';
import { successResponse } from '../../utils/response.js';
import { translateStrings } from './translation.service.js';
import { translateSchema } from './translation.validator.js';

export async function translate(req: Request, res: Response, next: NextFunction) {
  try {
    const body = translateSchema.parse(req.body);
    const result = await translateStrings({
      targetLanguage: body.targetLanguage,
      strings: body.strings,
      requesterId: req.ip || req.socket.remoteAddress || 'unknown',
    });

    return successResponse(res, 'Translations ready', {
      targetLanguage: body.targetLanguage,
      ...result,
    });
  } catch (error) {
    next(error);
  }
}
