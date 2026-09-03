import 'dotenv/config';
import app from './app.js';
import { env, hasDb } from './config/env.js';
import { logger } from './config/logger.js';
import { ensureMigrations } from './database/migrate.js';
import { pool } from './db/pool.js';
import { syncResourceCatalog } from './modules/resources/resource-catalog.repo.js';
import { startAutomaticAnalysisWorker, stopAutomaticAnalysisWorker } from './modules/agents/agent.worker.js';
import { startAgentExecutionWorker, stopAgentExecutionWorker } from './modules/agents/agent-execution.worker.js';
import { startAgentRunWorker, stopAgentRunWorker } from './modules/agents/agent-run.worker.js';
import { startEmailSyncWorker, stopEmailSyncWorker } from './modules/email/email.service.js';
import { startOnboardingFileCleanupWorker, stopOnboardingFileCleanupWorker } from './modules/onboarding/onboarding-cleanup.worker.js';
import { startPaygBillingWorker, stopPaygBillingWorker } from './modules/billing/payg-billing.worker.js';
import { startWebsiteGenerationWorker, stopWebsiteGenerationWorker } from './modules/websites/website.worker.js';
import { startCalendarSyncWorker, stopCalendarSyncWorker } from './modules/calendar/calendar.worker.js';
import { startRateLimitCleanupWorker, stopRateLimitCleanupWorker } from './middlewares/rateLimit.middleware.js';
import { startContentGenerationWorker, stopContentGenerationWorker } from './modules/content-generation/content-generation.worker.js';
import { startDomainEventRuntime, stopDomainEventRuntime } from './events/domain-event.runtime.js';

async function bootstrap() {
  if (env.RUN_MIGRATIONS_ON_STARTUP) {
    await ensureMigrations();
  }

  if (hasDb) {
    await syncResourceCatalog();
  }

  const workersEnabled = env.BACKGROUND_WORKERS_ENABLED && !process.env.VERCEL;

  if (workersEnabled) {
    startAutomaticAnalysisWorker();
    startAgentExecutionWorker();
    if (hasDb) {
      startAgentRunWorker();
      startContentGenerationWorker();
      startEmailSyncWorker();
      startCalendarSyncWorker();
      startRateLimitCleanupWorker();
      startWebsiteGenerationWorker();
      startOnboardingFileCleanupWorker();
      startPaygBillingWorker();
    }
  }

  const eventRuntimeEnabled = hasDb && !process.env.VERCEL;
  if (eventRuntimeEnabled) {
    await startDomainEventRuntime({ processEvents: workersEnabled });
  }

  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, environment: env.NODE_ENV, workersEnabled },
      'Lulu Growth OS API listening',
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down API');
    if (workersEnabled) {
      stopAutomaticAnalysisWorker();
      stopAgentExecutionWorker();
      if (hasDb) {
        stopAgentRunWorker();
        stopContentGenerationWorker();
      }
      stopEmailSyncWorker();
      stopCalendarSyncWorker();
      stopRateLimitCleanupWorker();
      stopWebsiteGenerationWorker();
      stopOnboardingFileCleanupWorker();
      stopPaygBillingWorker();
    }
    server.close(async () => {
      if (hasDb) {
        if (eventRuntimeEnabled) await stopDomainEventRuntime();
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
