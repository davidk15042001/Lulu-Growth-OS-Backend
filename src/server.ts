import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttpPkg from 'pino-http';
import { env, isProd } from './config/env.js';

const pinoHttp = (pinoHttpPkg as any).default ?? (pinoHttpPkg as any);
import { logger } from './config/logger.js';
import { ensureMigrations } from './database/migrate.js';
import v1Routes from './modules/v1.routes.js';
import { notFound } from './middlewares/notFound.middleware.js';
import { errorHandler } from './middlewares/error.middleware.js';

async function bootstrap() {
  // Ensure migrations are run on startup
  logger.info('Running migrations...');
  await ensureMigrations();
  logger.info('Migrations complete');

  // Create app
  const app = express();

  // Middleware stack
  app.use(
    pinoHttp({
      logger,
      level: env.LOG_LEVEL,
      transport: isProd ? undefined : { target: 'pino-pretty' },
      autoLogging: {
        ignore: (req: Request) => req.url === '/health',
      },
    })
  );
  app.use(helmet());
  const allowedOrigins = env.CORS_ORIGIN
    ? env.CORS_ORIGIN.split(',').map((s) => s.trim())
    : [];
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.length === 0) {
          return callback(null, origin ?? true);
        }
        if (allowedOrigins.includes(origin)) {
          return callback(null, origin);
        }
        return callback(null, false);
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());

  // Rate limiting
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: isProd ? 100 : 1000, // 100 requests per IP in production, more in dev
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api', limiter);

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString(), env: env.NODE_ENV });
  });

  // API routes
  app.use('/api/v1', v1Routes);

  // Error handling
  app.use(notFound);
  app.use(errorHandler);
  // app.all('/*', methodNotAllowed);

  // Start server
  const port = env.PORT;
  app.listen(port, () => {
    logger.info(`Server listening on port ${port} in ${env.NODE_ENV} mode`);
  });
}

// Bootstrap and handle errors
bootstrap().catch((err) => {
  logger.fatal({ err }, 'Failed to bootstrap server');
  process.exit(1);
});
