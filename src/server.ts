import 'dotenv/config';
import app from './app.js';
import { env, hasDb } from './config/env.js';
import { logger } from './config/logger.js';
import { ensureMigrations } from './database/migrate.js';
import { pool } from './db/pool.js';
import { syncResourceCatalog } from './modules/resources/resource-catalog.repo.js';
import { startAutomaticAnalysisWorker, stopAutomaticAnalysisWorker } from './modules/agents/agent.worker.js';
import { startEmailSyncWorker, stopEmailSyncWorker } from './modules/email/email.service.js';
import { startOnboardingFileCleanupWorker, stopOnboardingFileCleanupWorker } from './modules/onboarding/onboarding-cleanup.worker.js';
import { startPaygBillingWorker, stopPaygBillingWorker } from './modules/billing/payg-billing.worker.js';
import { startWebsiteGenerationWorker, stopWebsiteGenerationWorker } from './modules/websites/website.worker.js';

async function bootstrap() {
  if (env.RUN_MIGRATIONS_ON_STARTUP) {
    await ensureMigrations();
  }

  if (hasDb) {
    await syncResourceCatalog();
  }

  if (process.env.VERCEL) {
    return;
  }

  startAutomaticAnalysisWorker();
  if (hasDb) {
    startEmailSyncWorker();
    startWebsiteGenerationWorker();
    startOnboardingFileCleanupWorker();
    startPaygBillingWorker();
  }
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, environment: env.NODE_ENV }, 'Lulu Growth OS API listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down API');
    stopAutomaticAnalysisWorker();
    stopEmailSyncWorker();
    stopWebsiteGenerationWorker();
    stopOnboardingFileCleanupWorker();
    stopPaygBillingWorker();
    server.close(async () => {
      if (hasDb) {
        await pool.end();
      }
      process.exit(0);
    });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

try {
  await bootstrap();
} catch (error: unknown) {
  logger.fatal({ error }, 'Failed to bootstrap API');
  process.exit(1);
}

export default app;
