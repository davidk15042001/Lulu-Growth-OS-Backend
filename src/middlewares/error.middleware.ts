import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../config/logger.js';
import { isProd } from '../config/env.js';
import { AppError } from '../utils/app-error.js';

type DatabaseError = Error & { code?: string; detail?: string };

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) {
    return res.status(422).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }

  if (error instanceof AppError) {
    return res.status(error.status).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
  }

  const databaseError = error as DatabaseError;
  if (databaseError?.code === '23505') {
    return res.status(409).json({
      success: false,
      error: { code: 'CONFLICT', message: 'A record with these values already exists' },
    });
  }
  if (databaseError?.code === '23503') {
    return res.status(409).json({
      success: false,
      error: { code: 'REFERENCE_CONFLICT', message: 'A referenced record does not exist or is still in use' },
    });
  }

  logger.error({ error, requestId: req.id }, 'Unhandled request error');
  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: isProd ? 'Something went wrong' : databaseError?.message || 'Something went wrong',
    },
  });
}
