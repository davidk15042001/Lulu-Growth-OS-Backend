import type { Response } from 'express';

type ApiEnvelope<T = unknown> = {
  success: boolean;
  message: string;
  data: T | null;
};

type ErrorEnvelope = {
  success: false;
  error: {
    code: string;
    message: string;
  };
};

export function sendResponse<T>(res: Response, status: number, message: string, data: T | null = null) {
  const body: ApiEnvelope<T> = {
    success: status >= 200 && status < 300,
    message,
    data,
  };
  return res.status(status).json(body);
}

export function successResponse<T>(res: Response, message: string, data: T | null = null) {
  return sendResponse(res, 200, message, data);
}

export function createdResponse<T>(res: Response, message: string, data: T | null = null) {
  return sendResponse(res, 201, message, data);
}

export function errorResponse(res: Response, status: number, message: string) {
  return jsonError(res, status, 'REQUEST_ERROR', message);
}

export function jsonError(res: Response, status: number, code: string, message: string) {
  const body: ErrorEnvelope = { success: false, error: { code, message } };
  return res.status(status).json(body);
}

export function unauthorized(res: Response, errorMessage = 'Authentication required') {
  return jsonError(res, 401, 'UNAUTHORIZED', errorMessage);
}

export function forbidden(res: Response, errorMessage = 'Forbidden') {
  return jsonError(res, 403, 'FORBIDDEN', errorMessage);
}

export function notFoundError(res: Response, errorMessage = 'Resource not found') {
  return jsonError(res, 404, 'NOT_FOUND', errorMessage);
}

export function tooManyRequests(res: Response, errorMessage = 'Der Login ist vorübergehend pausiert. Bitte warten Sie kurz und versuchen Sie es erneut.') {
  return jsonError(res, 429, 'TOO_MANY_REQUESTS', errorMessage);
}
