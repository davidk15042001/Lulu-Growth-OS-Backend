import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { query } from '../db/pool.js';
import { hasDb } from '../config/env.js';
import { logger } from '../config/logger.js';
import { tooManyRequests } from '../utils/response.js';

type DbRateLimitOptions = {
  keyPrefix: string;
  windowMs: number;
  limit: number;
  message?: string;
  identifier?: (req: Request) => string | null | undefined;
  cost?: (req: Request) => number;
};

function defaultIdentifier(req: Request) {
  const userId = (req as Request & { user?: { id: string } }).user?.id;
  return userId ? `user:${userId}` : `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
}

export function dbRateLimit(opts: DbRateLimitOptions) {
  const { keyPrefix, windowMs, limit, message, identifier, cost } = opts;
  const memoryWindows = new Map<string, { count: number; expiresAt: number }>();

  return async function dbRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
      const subject = identifier?.(req) || defaultIdentifier(req);
      const key = `${keyPrefix}:${subject}`;
      const rawIncrement = cost?.(req) ?? 1;
      const increment = Number.isFinite(rawIncrement)
        ? Math.max(1, Math.min(1_000_000, Math.trunc(rawIncrement)))
        : 1;
      const windowStartMs = Math.floor(Date.now() / windowMs) * windowMs;

      if (!hasDb) {
        const memoryKey = `${key}:${windowStartMs}`;
        const current = memoryWindows.get(memoryKey);
        const count = (current?.count ?? 0) + increment;
        memoryWindows.set(memoryKey, { count, expiresAt: windowStartMs + windowMs });
        if (memoryWindows.size > 10_000) {
          const now = Date.now();
          for (const [entryKey, entry] of memoryWindows) {
            if (entry.expiresAt <= now) memoryWindows.delete(entryKey);
          }
        }
        if (count > limit) return tooManyRequests(res, message);
        next();
        return;
      }

      const windowStart = new Date(windowStartMs).toISOString();

      const { rows } = await query<{ count: number }>(
        `INSERT INTO rate_limits (key, window_start, count, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (key, window_start)
         DO UPDATE SET count = rate_limits.count + EXCLUDED.count, updated_at = NOW()
         RETURNING count`,
        [key, windowStart, increment]
      );

      const current = rows[0]?.count ?? increment;
      if (current > limit) {
        return tooManyRequests(res, message);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

export async function cleanupRateLimits(olderThanMs = 1000 * 60 * 60 * 24 * 2) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  await query('DELETE FROM rate_limits WHERE window_start < $1', [cutoff]);
}

let cleanupTimer: NodeJS.Timeout | undefined;

export function startRateLimitCleanupWorker() {
  if (cleanupTimer || !hasDb) return;
  const run = () => void cleanupRateLimits().catch((error: unknown) => {
    logger.error({ error }, 'Expired rate-limit windows could not be removed');
  });
  cleanupTimer = setInterval(run, 6 * 60 * 60 * 1000);
  cleanupTimer.unref();
  run();
}

export function stopRateLimitCleanupWorker() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = undefined;
}

export const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => tooManyRequests(res),
});

