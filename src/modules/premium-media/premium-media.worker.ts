import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { query } from '../../db/pool.js';
import * as repo from './premium-media.repo.js';
import {
  advancePremiumMediaJob,
  maybeStartAutonomousPremiumMedia,
  pollCandidate,
  processCandidate,
  recordCandidateProviderUsage,
  startPremiumMediaFromProductBrief,
} from './premium-media.service.js';

const workerId = `premium-media-${process.pid}-${randomUUID()}`;
let timer: NodeJS.Timeout | undefined;
let activeCycle: Promise<void> | null = null;
let stopping = false;
let initialSweepComplete = false;

function errorDetails(error: unknown) {
  return {
    code: typeof error === 'object' && error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'PREMIUM_MEDIA_PROCESSING_FAILED',
    message: error instanceof Error ? error.message : 'Unknown premium media processing error',
  };
}

export function runPremiumMediaCycle(): Promise<void> {
  if (activeCycle) return activeCycle;
  activeCycle = (async () => {
    await repo.failStaleSubmittingCandidates(Math.max(300, env.KIE_MEDIA_POLL_AFTER_SECONDS * 4));
    await repo.failTimedOutProviderCandidates(env.KIE_MEDIA_TASK_TIMEOUT_MINUTES);

    if (!initialSweepComplete) {
      initialSweepComplete = true;
      if (env.KIE_API_KEY && env.AWS_S3_BUCKET) {
        const products = await repo.listProductsAwaitingFirstProduction();
        for (const product of products) {
          if (stopping) return;
          await maybeStartAutonomousPremiumMedia(product.workspaceId, product.productId);
        }
      }
    }

    const polling = await repo.listCandidatesNeedingPoll(env.KIE_MEDIA_POLL_AFTER_SECONDS, 30);
    for (const candidate of polling) {
      if (stopping) return;
      try {
        await pollCandidate(candidate);
      } catch (error) {
        await repo.touchCandidate(candidate.id).catch(() => undefined);
        logger.warn({ error, candidateId: candidate.id, providerTaskId: candidate.providerTaskId }, 'Premium media provider poll failed');
      }
    }

    while (!stopping) {
      const candidate = await repo.claimCandidateForProcessing(workerId, 5);
      if (!candidate) break;
      try {
        await processCandidate(candidate, workerId);
      } catch (error) {
        const details = errorDetails(error);
        await repo.releaseCandidateForRetry(candidate.id, workerId, details.code, details.message);
        logger.warn({ error, candidateId: candidate.id, processingAttempt: candidate.processingAttempts }, 'Premium media quality processing will retry');
      }
    }

    const unrecorded = await repo.listUnrecordedProviderUsage();
    for (const candidate of unrecorded) {
      if (stopping) return;
      try {
        await recordCandidateProviderUsage(candidate);
      } catch (error) {
        logger.warn({ error, candidateId: candidate.id }, 'Premium media provider usage metering will retry');
      }
    }

    const jobs = await repo.listActiveJobs();
    for (const job of jobs) {
      if (stopping) return;
      try {
        await advancePremiumMediaJob(job);
      } catch (error) {
        const details = errorDetails(error);
        await repo.failJob(job, details.code, details.message);
        logger.error({ error, jobId: job.id, status: job.status }, 'Premium media workflow failed safely');
      }
    }
  })()
    .catch((error: unknown) => logger.error({ error }, 'Premium media worker cycle failed'))
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

export function requestPremiumMediaWorkerRun() {
  if (!stopping) void runPremiumMediaCycle();
}

export async function listKnowledgeProductsAwaitingImages(workspaceId: string) {
  return (await query<{id:string}>(`SELECT p.id FROM products p WHERE p.workspace_id=$1 AND p.deleted_at IS NULL AND EXISTS(SELECT 1 FROM workspace_knowledge_activations ka WHERE ka.workspace_id=p.workspace_id AND ka.status='COMPLETED' AND ka.classification->'canonicalProductIds' ? p.id::text) AND NOT EXISTS(SELECT 1 FROM product_media m WHERE m.workspace_id=p.workspace_id AND m.product_id=p.id AND m.media_type='IMAGE') AND NOT EXISTS(SELECT 1 FROM premium_media_jobs j WHERE j.workspace_id=p.workspace_id AND j.product_id=p.id AND j.status NOT IN ('FAILED','CANCELLED')) ORDER BY p.created_at LIMIT 20`,[workspaceId])).rows;
}

export function startPremiumMediaWorker() {
  if (timer) return;
  registerDomainEventHandler({
    name: 'premium-media.autonomous-production.v1',
    eventTypes: [
      DOMAIN_EVENT_TYPES.PRODUCT_MEDIA_ADDED,
    ],
    async handle(event) {
      if (!event.workspaceId || !event.aggregateId || event.metadata.source === 'premium-media') return { skipped: true };
      const actorId = typeof event.metadata.actorId === 'string' ? event.metadata.actorId : null;
      const result = await maybeStartAutonomousPremiumMedia(event.workspaceId, event.aggregateId, actorId);
      requestPremiumMediaWorkerRun();
      return { started: Boolean(result) };
    },
  });
  registerDomainEventHandler({
    name: 'premium-media.resume-after-api-funding.v1',
    eventTypes: [DOMAIN_EVENT_TYPES.API_FUNDS_FUNDED],
    async handle(event) {
      if (!event.workspaceId || typeof event.metadata.actorId !== 'string') return { skipped: true };
      const products = await listKnowledgeProductsAwaitingImages(event.workspaceId);
      let started=0;
      for(const product of products){await startPremiumMediaFromProductBrief(event.workspaceId,product.id,event.metadata.actorId,false,false);started+=1;}
      requestPremiumMediaWorkerRun();
      return {started};
    },
  });
  stopping = false;
  initialSweepComplete = false;
  timer = setInterval(requestPremiumMediaWorkerRun, env.KIE_MEDIA_WORKER_INTERVAL_MS);
  timer.unref();
  requestPremiumMediaWorkerRun();
  logger.info({ workerId, intervalMs: env.KIE_MEDIA_WORKER_INTERVAL_MS }, 'Autonomous premium media worker started');
}

export function stopPremiumMediaWorker() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = undefined;
}
