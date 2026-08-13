import type { Request, Response } from 'express';
import { jsonError } from '../utils/response.js';

export function methodNotAllowed(_req: Request, res: Response) {
  return jsonError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
}
