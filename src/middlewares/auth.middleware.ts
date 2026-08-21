import type { Request, Response, NextFunction } from 'express';
import { query } from '../db/pool.js';
import { forbidden, jsonError, unauthorized } from '../utils/response.js';
import { logger } from '../config/logger.js';
import { extractBearerToken, verifyToken, type JwtPayload } from '../utils/jwt.js';

export type AuthedRequest = Request & { user?: { id: string; email: string; role: 'user' | 'admin' } };

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = extractBearerToken(req.headers.authorization as string | undefined);
  if (!token) return unauthorized(res, 'Authentication required');

  try {
    const payload = verifyToken<JwtPayload>(token);
    const { rows } = await query<{ token_version: number; role: 'user' | 'admin'; deleted_at: string | null }>(
      'SELECT token_version, role, deleted_at FROM users WHERE id=$1',
      [payload.sub]
    );

    const row = rows[0];
    if (!row) return unauthorized(res, 'Invalid token');

    const { token_version, role, deleted_at } = row;

    if (deleted_at) {
      logger.error('Account disabled');
      return forbidden(res, 'Account disabled');
    }

    if ((payload.tv ?? 0) !== token_version) {
      logger.error('Token revoked');
      return jsonError(res, 401, 'TOKEN_REVOKED', 'This session was ended because the account signed in somewhere else');
    }

    req.user = { id: payload.sub, email: payload.email, role };
    next();
  } catch {
    logger.error('Invalid token');
    return unauthorized(res, 'Invalid token');
  }
}
