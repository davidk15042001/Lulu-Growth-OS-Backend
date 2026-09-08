import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../config/logger.js';
import { isProd, hasDb } from '../config/env.js';
import { AppError } from '../utils/app-error.js';
import { recordSecurityEvent } from '../modules/security/security-event.service.js';
import type { WorkspaceRequest } from './workspace.middleware.js';

type DatabaseError = Error & { code?: string; detail?: string };

type DiagnosticContext = {
  requestId: string;
  endpoint: string;
  timestamp: string;
};

function diagnosticContext(req: Request): DiagnosticContext {
  return {
    requestId: String(req.id || 'request-id-unavailable'),
    endpoint: `${req.method} ${req.originalUrl}`,
    timestamp: new Date().toISOString(),
  };
}

function errorPayload(req: Request, code: string, message: string, details?: unknown) {
  const diagnostics = diagnosticContext(req);
  return {
    success: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      diagnostics,
    },
  };
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  const diagnostics = diagnosticContext(req);
  res.setHeader('X-Request-ID', diagnostics.requestId);
  // Persist operational diagnostics, never request bodies, query strings,
  // stack traces or provider responses. A logging failure must not recurse.
  const status=error instanceof AppError?error.status:500;
  const expected=error instanceof ZodError || ['23505','23503'].includes((error as DatabaseError)?.code??'');
  if(hasDb && status>=500 && !expected) {
    const context=req as WorkspaceRequest;
    void recordSecurityEvent({eventType:'API_ERROR',userId:context.user?.id??null,
      workspaceId:context.workspaceAccess?.id??null,requestId:diagnostics.requestId,
      metadata:{outcome:status,action:error instanceof AppError?error.code:'INTERNAL_ERROR',reason:`${req.method} ${String(req.route?.path??'unknown')}`}})
      .catch(()=>logger.error('Operational error event could not be persisted'));
  }

  if (error instanceof ZodError) {
    return res.status(422).json(errorPayload(req, 'VALIDATION_ERROR', 'Request validation failed', error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }))));
  }

  if (error instanceof AppError) {
    return res.status(error.status).json(errorPayload(req, error.code, error.message, error.details));
  }

  const databaseError = error as DatabaseError;
  if (databaseError?.code === '23505') {
    return res.status(409).json(errorPayload(req, 'CONFLICT', 'A record with these values already exists'));
  }
  if (databaseError?.code === '23503') {
    return res.status(409).json(errorPayload(req, 'REFERENCE_CONFLICT', 'A referenced record does not exist or is still in use'));
  }

  logger.error({ error, requestId: diagnostics.requestId }, 'Unhandled request error');
  return res.status(500).json(errorPayload(req, 'INTERNAL_ERROR', isProd ? 'Something went wrong' : databaseError?.message || 'Something went wrong'));
}
