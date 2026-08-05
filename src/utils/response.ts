import type { Response } from 'express';

type ApiEnvelope<T = unknown> = {
  success: boolean;
  message: string;
  data: T | null;
};

type ErrorEnvelope = {
  error: string;
  errorMessage: string;
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
  return sendResponse(res, status, message);
}

export function jsonError(res: Response, status: number, error: string, errorMessage: string) {
  const body: ErrorEnvelope = { error, errorMessage };
  return res.status(status).json(body);
}

export function unauthorized(res: Response, errorMessage = 'Authentication required') {
  return jsonError(res, 401, 'Unauthorized', errorMessage);
}

export function forbidden(res: Response, errorMessage = 'Forbidden') {
  return jsonError(res, 403, 'Forbidden', errorMessage);
}

export function notFoundError(res: Response, errorMessage = 'Resource not found') {
  return jsonError(res, 404, 'Not Found', errorMessage);
}

export function tooManyRequests(res: Response, errorMessage = 'Too many requests') {
  return jsonError(res, 429, 'Too Many Requests', errorMessage);
}
