export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorizedError = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbiddenError = (message = 'You do not have permission') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFoundError = (message = 'Resource not found') =>
  new AppError(404, 'NOT_FOUND', message);

export const conflictError = (message: string) =>
  new AppError(409, 'CONFLICT', message);
