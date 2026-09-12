import 'dotenv/config';
import app from './app.js';
import { env, hasAiProvider, hasDb } from './config/env.js';
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
import { startAdminUserDeletionWorker, stopAdminUserDeletionWorker } from './modules/admin/admin-user-deletion.worker.js';
import { startProviderControlWorkers, stopProviderControlWorkers } from './modules/provider-control/provider.worker.js';
import { startAssistantActionWorker, stopAssistantActionWorker } from './modules/ai/assistant-action.worker.js';
import { startCommercialDocumentDeliveryWorker, stopCommercialDocumentDeliveryWorker } from './modules/commercial-documents/commercial-document.delivery.service.js';
import { startPremiumMediaWorker, stopPremiumMediaWorker } from './modules/premium-media/premium-media.worker.js';
import { startCompanyIntelligenceWorker } from './modules/crm-company/company-intelligence.worker.js';
import { startOmnichannelAiReplyWorker } from './modules/omnichannel/omnichannel.ai-reply.worker.js';
import { probeAiRuntime } from './modules/ai/openai.service.js';

async function bootstrap() {
  if (env.RUN_MIGRATIONS_ON_STARTUP) {
    await ensureMigrations();
  }

  if (hasDb) {
    await syncResourceCatalog();
  }

  if (hasAiProvider) {
    await probeAiRuntime().catch((error) => {
      logger.error({ error }, 'AI startup probe failed; readiness will remain unavailable until a provider succeeds');
    });
  }

  const workersEnabled = env.BACKGROUND_WORKERS_ENABLED && !process.env.VERCEL;

  if (workersEnabled) {
    startAutomaticAnalysisWorker();
    startAgentExecutionWorker();
    if (hasDb) {
      startAssistantActionWorker();
      startAgentRunWorker();
      startContentGenerationWorker();
      startEmailSyncWorker();
      startCalendarSyncWorker();
      startRateLimitCleanupWorker();
      startWebsiteGenerationWorker();
      startOnboardingFileCleanupWorker();
      startPaygBillingWorker();
      startAdminUserDeletionWorker();
      startProviderControlWorkers();
      startCommercialDocumentDeliveryWorker();
      startPremiumMediaWorker();
      startCompanyIntelligenceWorker();
      startOmnichannelAiReplyWorker();
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

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down API');
    if (workersEnabled) {
      stopAutomaticAnalysisWorker();
      stopAgentExecutionWorker();
      if (hasDb) {
        stopAssistantActionWorker();
        stopAgentRunWorker();
        stopContentGenerationWorker();
      }
      stopEmailSyncWorker();
      stopCalendarSyncWorker();
      stopRateLimitCleanupWorker();
      stopWebsiteGenerationWorker();
      stopOnboardingFileCleanupWorker();
      stopPaygBillingWorker();
      stopAdminUserDeletionWorker();
      await stopProviderControlWorkers();
      stopCommercialDocumentDeliveryWorker();
      stopPremiumMediaWorker();
    }
    server.close(async () => {
      if (hasDb) {
        if (eventRuntimeEnabled) await stopDomainEventRuntime();
        await pool.end();
      }
      process.exit(0);
    });
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

try {
  await bootstrap();
} catch (error: unknown) {
  logger.fatal({ error }, 'Failed to bootstrap API');
  process.exit(1);
}

export default app;
