import type { NextFunction, Request, Response } from 'express';
import { successResponse } from '../../utils/response.js';
import { getLandingKpis } from './landing-kpis.service.js';

export async function get(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getLandingKpis();
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return successResponse(res, 'Landing KPIs loaded', data);
  } catch (error) {
    next(error);
  }
}
