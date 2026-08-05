import type { Request, Response } from 'express';
import { notFoundError } from '../utils/response.js';

export function notFound(_req: Request, res: Response) {
  return notFoundError(res);
}
