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
import { startCatalogImportWorker, stopCatalogImportWorker } from './modules/onboarding/onboarding-catalog-import.worker.js';
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
import { startCompanyIntelligenceWorker, stopCompanyIntelligenceWorker } from './modules/crm-company/company-intelligence.worker.js';
import { startOmnichannelAiReplyWorker, stopOmnichannelAiReplyWorker } from './modules/omnichannel/omnichannel.ai-reply.worker.js';
import { startWorkerSupervisorHeartbeat, stopWorkerSupervisorHeartbeat } from './operations/worker-liveness.js';
import { startSocialPublishingWorker, stopSocialPublishingWorker } from './modules/social-publishing/social-publishing.worker.js';
import { startGoogleAdsSpendReconciliationWorker, stopGoogleAdsSpendReconciliationWorker } from './modules/adspend/google-ads-spend.worker.js';
import { startQualityIntelligenceWorker, stopQualityIntelligenceWorker } from './modules/quality/quality.worker.js';
import { registerCompanyBrainEventHandler } from './modules/company-brain/company-brain.event-handler.js';
import { registerAgentMemoryEventHandler } from './modules/agent-memory/agent-memory.event-handler.js';
import { startCompanyBrainTaskWorker, stopCompanyBrainTaskWorker } from './modules/company-brain/company-brain.worker.js';
import { startIntegrationSyncWorker, stopIntegrationSyncWorker } from './modules/workspace-app/integration-sync.worker.js';
import { startExecutiveOperatingWorker, stopExecutiveOperatingWorker } from './modules/executive-ops/executive-ops.worker.js';
import { autonomousWorkerManifest } from './operations/autonomous-worker-manifest.js';
import {
  createIdempotentShutdown,
  drainRuntime,
  GracefulShutdownTimeoutError,
  withGracefulShutdownDeadline,
} from './operations/graceful-shutdown.js';

const workersEnabled = env.BACKGROUND_WORKERS_ENABLED && !process.env.VERCEL;
const eventRuntimeEnabled = hasDb && !process.env.VERCEL;

async function stopBackgroundWorkers() {
  if (!workersEnabled) return;
  const results = await Promise.allSettled([
    stopAutomaticAnalysisWorker(),
    stopAgentExecutionWorker(),
    ...(hasDb ? [
      stopAssistantActionWorker(),
      stopAgentRunWorker(),
      stopContentGenerationWorker(),
      stopEmailSyncWorker(),
      stopCalendarSyncWorker(),
      stopRateLimitCleanupWorker(),
      stopWebsiteGenerationWorker(),
      stopOnboardingFileCleanupWorker(),
      stopCatalogImportWorker(),
      stopPaygBillingWorker(),
      stopAdminUserDeletionWorker(),
      stopProviderControlWorkers(),
      stopCommercialDocumentDeliveryWorker(),
      stopPremiumMediaWorker(),
      stopCompanyIntelligenceWorker(),
      stopOmnichannelAiReplyWorker(),
      stopSocialPublishingWorker(),
      stopGoogleAdsSpendReconciliationWorker(),
      stopQualityIntelligenceWorker(),
      stopCompanyBrainTaskWorker(),
      stopExecutiveOperatingWorker(),
      stopIntegrationSyncWorker(),
    ] : []),
  ]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'One or more background workers failed to drain');
}

async function bootstrap() {
  registerCompanyBrainEventHandler();
  registerAgentMemoryEventHandler();
  if (env.RUN_MIGRATIONS_ON_STARTUP) {
    await ensureMigrations();
  }

  if (hasDb) {
    await syncResourceCatalog();
  }

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
      startCatalogImportWorker();
      startPaygBillingWorker();
      startAdminUserDeletionWorker();
      startProviderControlWorkers();
      startCommercialDocumentDeliveryWorker();
      startPremiumMediaWorker();
      startCompanyIntelligenceWorker();
      startOmnichannelAiReplyWorker();
      startSocialPublishingWorker();
      startGoogleAdsSpendReconciliationWorker();
      startQualityIntelligenceWorker();
      startCompanyBrainTaskWorker();
      startExecutiveOperatingWorker();
      startIntegrationSyncWorker();
      await startWorkerSupervisorHeartbeat(autonomousWorkerManifest);
    }
  }

  if (eventRuntimeEnabled) {
    await startDomainEventRuntime({ processEvents: workersEnabled });
  }

  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, environment: env.NODE_ENV, workersEnabled },
      'Lulu Growth OS API listening',
    );
  });

  const closeHttpIntake = () => new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
  });

  const shutdown = createIdempotentShutdown((signal: string) => {
    logger.info({ signal, gracePeriodMs: env.SHUTDOWN_GRACE_PERIOD_MS }, 'Shutting down API');
    const drain = drainRuntime({
      closeHttpIntake,
      stopDomainRuntime: () => eventRuntimeEnabled ? stopDomainEventRuntime() : Promise.resolve(),
      stopWorkers: stopBackgroundWorkers,
      stopSupervisor: () => workersEnabled && hasDb ? stopWorkerSupervisorHeartbeat() : Promise.resolve(),
      closePool: () => hasDb ? pool.end() : Promise.resolve(),
    });
    return withGracefulShutdownDeadline(drain, env.SHUTDOWN_GRACE_PERIOD_MS)
      .then(() => {
        process.exitCode = 0;
        logger.info({ signal }, 'API shutdown completed');
      });
  });

  const onSignal = (signal: 'SIGTERM' | 'SIGINT') => {
    void shutdown(signal).catch((error: unknown) => {
      server.closeAllConnections?.();
      if (error instanceof GracefulShutdownTimeoutError) {
        logger.fatal({ error, signal, gracePeriodMs: error.timeoutMs }, 'API shutdown deadline exceeded; forcing termination');
      } else {
        logger.fatal({ error, signal }, 'API shutdown failed; forcing termination');
      }
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

try {
  await bootstrap();
} catch (error: unknown) {
  logger.fatal({ error }, 'Failed to bootstrap API');
  await stopDomainEventRuntime().catch(() => undefined);
  await stopBackgroundWorkers().catch(() => undefined);
  if (workersEnabled && hasDb) await stopWorkerSupervisorHeartbeat().catch(() => undefined);
  if (hasDb) await pool.end().catch(() => undefined);
  process.exitCode = 1;
}

export default app;
