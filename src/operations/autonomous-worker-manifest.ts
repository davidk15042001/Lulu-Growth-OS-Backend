import { env } from '../config/env.js';
import type { RuntimeWorkerDefinition } from './worker-liveness.js';

/**
 * Workers whose absence would make the Autonomous Company OS claim false are
 * readiness-critical. Housekeeping workers remain observable without taking
 * the customer API out of rotation for a delayed cleanup cycle.
 */
export const autonomousWorkerManifest = [
  { name: 'agent-execution', required: true, staleAfterMs: 120_000 },
  { name: 'agent-runs', required: true, staleAfterMs: Math.max(60_000, env.AGENT_RUN_WORKER_INTERVAL_MS * 4) },
  { name: 'domain-events', required: true, staleAfterMs: Math.max(60_000, env.EVENT_WORKER_POLL_INTERVAL_MS * 4) },
  { name: 'automatic-analysis', required: true },
  { name: 'assistant-actions', required: true },
  { name: 'content-generation', required: true },
  { name: 'email-sync', required: true },
  { name: 'calendar-sync', required: true },
  { name: 'website-generation', required: true },
  { name: 'payg-billing', required: true },
  { name: 'admin-user-deletion', required: true },
  { name: 'provider-control', required: true },
  { name: 'commercial-document-delivery', required: true },
  { name: 'premium-media', required: true },
  { name: 'company-intelligence', required: true },
  { name: 'omnichannel-ai-reply', required: true },
  { name: 'social-publishing', required: true },
  { name: 'google-ads-spend-reconciliation', required: true, staleAfterMs: Math.max(180_000, env.GOOGLE_ADS_RECONCILIATION_WORKER_INTERVAL_MS * 4) },
  { name: 'quality-intelligence', required: true, staleAfterMs: 120_000, eventDriven: true },
  { name: 'company-brain-task-dispatch', required: true, staleAfterMs: 60_000, eventDriven: true },
  { name: 'integration-sync', required: true, staleAfterMs: Math.max(60_000, env.INTEGRATION_SYNC_WORKER_INTERVAL_MS * 4) },
  { name: 'rate-limit-cleanup', required: false },
  { name: 'onboarding-cleanup', required: false },
] as const satisfies readonly RuntimeWorkerDefinition[];
