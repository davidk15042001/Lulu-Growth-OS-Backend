import express, { type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { env } from './config/env.js';
import { requestLogger } from './config/logger.js';
import { checkDatabase } from './db/pool.js';
import { rateLimiter } from './middlewares/rateLimit.middleware.js';
import { notFound } from './middlewares/notFound.middleware.js';
import { errorHandler } from './middlewares/error.middleware.js';
import v1Routes from './modules/v1.routes.js';

export function createApp() {
  const app = express();

  if (env.TRUST_PROXY) {
    app.set('trust proxy', 1);
  }

  app.disable('x-powered-by');
  app.use(requestLogger);
  app.use(helmet());

  const allowedOrigins = (env.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
    })
  );

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      data: {
        status: 'ok',
        environment: env.NODE_ENV,
        timestamp: new Date().toISOString(),
      },
    });
  });

  app.get('/ready', async (_req: Request, res: Response, next) => {
    try {
      const database = await checkDatabase();
      const ready = database.configured && database.connected;
      res.status(ready ? 200 : 503).json({
        success: ready,
        data: { status: ready ? 'ready' : 'not_ready', database },
      });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', rateLimiter);
  app.use('/api/v1', v1Routes);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

const app = createApp();
export default app;
