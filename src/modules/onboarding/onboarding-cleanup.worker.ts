import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { deleteObject } from '../../storage/s3.service.js';
import * as repo from './onboarding-cleanup.repo.js';

const RETENTION_DAYS = 5;
const CLAIM_LEASE_MINUTES = 30;
const MAX_WORKSPACES_PER_CYCLE = 100;

let interval: NodeJS.Timeout | undefined;
let activeCycle: Promise<void> | null = null;
let stopping = false;

async function cleanupWorkspace(workspaceId: string) {
  try {
    const documents = await repo.listOnboardingCleanupDocuments(workspaceId);
    for (const document of documents) {
      if (document.storageKey) await deleteObject(document.storageKey);
    }
    await repo.finishOnboardingFileCleanup(
      workspaceId,
      documents.map((document) => document.id),
      RETENTION_DAYS,
    );
    logger.info(
      { workspaceId, deletedDocuments: documents.length, retentionDays: RETENTION_DAYS },
      'Expired unpaid onboarding files deleted',
    );
  } catch (error) {
    await repo.releaseOnboardingFileCleanupClaim(workspaceId).catch((releaseError: unknown) => {
      logger.error({ workspaceId, error: releaseError }, 'Could not release onboarding cleanup claim');
    });
    throw error;
  }
}

export function runOnboardingFileCleanupCycle(): Promise<void> {
  if (activeCycle) return activeCycle;

  activeCycle = (async () => {
    for (let processed = 0; processed < MAX_WORKSPACES_PER_CYCLE && !stopping; processed += 1) {
      const workspace = await repo.claimExpiredOnboardingWorkspace(CLAIM_LEASE_MINUTES);
      if (!workspace) return;
      await cleanupWorkspace(workspace.workspaceId);
    }
  })()
    .catch((error: unknown) => logger.error({ error }, 'Onboarding file cleanup cycle failed'))
    .finally(() => { activeCycle = null; });

  return activeCycle;
}

export function startOnboardingFileCleanupWorker() {
  if (interval) return;
  stopping = false;
  const intervalMs = env.ONBOARDING_FILE_CLEANUP_INTERVAL_MINUTES * 60_000;
  interval = setInterval(() => void runOnboardingFileCleanupCycle(), intervalMs);
  interval.unref();
  void runOnboardingFileCleanupCycle();
  logger.info(
    { intervalMinutes: env.ONBOARDING_FILE_CLEANUP_INTERVAL_MINUTES, retentionDays: RETENTION_DAYS },
    'Onboarding file cleanup worker started',
  );
}

export function stopOnboardingFileCleanupWorker() {
  stopping = true;
  if (interval) clearInterval(interval);
  interval = undefined;
}
