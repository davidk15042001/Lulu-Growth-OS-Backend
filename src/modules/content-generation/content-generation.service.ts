import { conflictError } from '../../utils/app-error.js';
import * as repo from './content-generation.repo.js';
import { startAutomaticRun } from '../agents/agent.service.js';
import * as agentRepo from '../agents/agent.repo.js';
import type { AgentModule } from '../agents/agent.capabilities.js';
import * as onboardingService from '../onboarding/onboarding.service.js';
import * as aiProfileService from '../onboarding/onboarding.ai-profile.service.js';
import fs from 'node:fs';

const ACTIVE_JOB_STALE_MS = 2 * 60 * 1000;

function reportDebug(hypothesisId: string, location: string, msg: string, data: Record<string, unknown>) {
  try {
    const env = fs.readFileSync('.dbg/update-button-broken.env', 'utf8');
    const url = env.match(/DEBUG_SERVER_URL=(.+)/)?.[1] ?? 'http://127.0.0.1:7777/event';
    const sessionId = env.match(/DEBUG_SESSION_ID=(.+)/)?.[1] ?? 'update-button-broken';
    fetch(url, {
      method: 'POST',
      body: JSON.stringify({ sessionId, runId: 'pre-fix', hypothesisId, location, msg, data, ts: Date.now() }),
    }).catch(() => undefined);
  } catch {
    fetch('http://127.0.0.1:7777/event', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'update-button-broken', runId: 'pre-fix', hypothesisId, location, msg, data, ts: Date.now() }),
    }).catch(() => undefined);
  }
}

const moduleGoals: Record<repo.ContentModule, string> = {
  website: '[content-generation:website] Generate reusable website architecture, page copy briefs and conversion assets from the approved workspace intelligence.',
  seo: '[content-generation:seo] Generate reusable SEO clusters, metadata briefs and editorial opportunities from the approved workspace intelligence.',
  marketing: '[content-generation:marketing] Generate reusable marketing content pillars, campaign concepts and publishing calendar assets.',
  advertisement: '[content-generation:advertisement] Generate reusable advertisement angles, headline variants and landing-page mappings without publishing campaigns.',
  email: '[content-generation:email] Generate reusable lifecycle email sequences, subject lines and CTA variants without sending messages.',
  analytics: '[content-generation:analytics] Generate measurement goals, events, KPI definitions and UTM conventions from the workspace intelligence.',
  competitors: '[content-generation:competitors] Discover and refresh the top competitors for the workspace using the latest business context.',
  knowledge: '[content-generation:knowledge] Refresh the AI knowledge draft including positioning, customer segments, and competitor comparison.',
};

export async function startContentRefresh(workspaceId: string, userId: string, requestedModules: repo.ContentModule[] = [...repo.CONTENT_MODULES]) {
  const active = await repo.getActiveJob(workspaceId);
  const heartbeatAt = active?.heartbeatAt ? Date.parse(active.heartbeatAt) : NaN;
  const updatedAt = active?.updatedAt ? Date.parse(active.updatedAt) : NaN;
  const lastSeenAt = Number.isFinite(heartbeatAt) ? heartbeatAt : updatedAt;
  const staleActiveJob = active && Number.isFinite(lastSeenAt) && Date.now() - lastSeenAt > ACTIVE_JOB_STALE_MS;
  // #region debug-point D:backend-start-refresh
  reportDebug('D', 'src/modules/content-generation/content-generation.service.ts:startContentRefresh', '[DEBUG] Backend starts workspace refresh request', { workspaceId, userId, requestedModules, reusedActiveJob: Boolean(active && !staleActiveJob), activeJobId: active?.id ?? null, staleActiveJob: Boolean(staleActiveJob), activeJobHeartbeatAt: active?.heartbeatAt ?? null, activeJobUpdatedAt: active?.updatedAt ?? null });
  // #endregion
  if (staleActiveJob && active) {
    await repo.updateJob(workspaceId, active.id, {
      status: 'failed',
      current_phase: 'failed',
      error_message: 'The previous workspace refresh stopped sending heartbeats and was marked stale.',
      completed_at: new Date(),
      heartbeat_at: new Date(),
    });
  }
  if (active && !staleActiveJob) return { job: active, reused: true };
  const job = await repo.createJob(workspaceId, userId, requestedModules);
  if (!job) throw conflictError('The workspace content refresh could not be created');
  return { job, reused: false };
}

export async function getContentRefresh(workspaceId: string, jobId: string) {
  const job = await repo.getJob(workspaceId, jobId);
  if (!job) return null;
  return job;
}

export async function listContentAssets(workspaceId: string, module?: repo.ContentModule) {
  return repo.listLatestAssets(workspaceId, module);
}

async function waitForRun(workspaceId: string, runId: string, jobId: string, moduleStatus: Record<string, unknown>, module: repo.ContentModule) {
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const run = await agentRepo.getRun(workspaceId, runId);
    if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    if (run.status === 'waiting_approval') {
      moduleStatus[module] = {
        ...(moduleStatus[module] as Record<string, unknown>),
        status: 'blocked_by_approval',
        runId,
        error: 'Automatic workspace refresh reached an approval-gated action and is waiting for a user decision.',
      };
      await repo.updateJob(workspaceId, jobId, { module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
      return {
        ...run,
        status: 'waiting_approval',
        errorMessage: 'Automatic workspace refresh reached an approval-gated action and is waiting for a user decision.',
      };
    }
    moduleStatus[module] = { ...(moduleStatus[module] as Record<string, unknown>), status: run.status };
    await repo.updateJob(workspaceId, jobId, { module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { status: 'failed', errorMessage: 'Content module generation timed out' } as const;
}

async function executeManualModule(workspaceId: string, userId: string, module: Extract<repo.ContentModule, 'competitors' | 'knowledge'>) {
  if (module === 'competitors') {
    const items = await onboardingService.discoverCompetitors(workspaceId, userId);
    await repo.createAsset({
      workspaceId,
      module,
      title: 'competitors workspace intelligence',
      content: {
        generatedAt: new Date().toISOString(),
        count: items.length,
        items,
      },
      sourceManifest: { generatedBy: 'workspace-content-refresh', module },
    });
    return { count: items.length };
  }

  const profile = await aiProfileService.generateAiBusinessProfile(workspaceId, userId);
  if (!profile) throw conflictError('The workspace knowledge refresh could not be created');
  await repo.createAsset({
    workspaceId,
    module,
    title: 'knowledge workspace intelligence',
    content: profile.payload as Record<string, unknown>,
    sourceManifest: { generatedBy: 'workspace-content-refresh', module },
  });
  return {
    competitorCount: profile.payload.competitorComparison.length,
    customerSegmentCount: profile.payload.customerSegments.length,
  };
}

export async function executeContentRefresh(workspaceId: string, userId: string, jobId: string, modules: repo.ContentModule[]) {
  try {
    await repo.updateJob(workspaceId, jobId, { status: 'running', current_phase: 'modules', started_at: new Date(), heartbeat_at: new Date() });
    const moduleStatus: Record<string, unknown> = {};
    for (let index = 0; index < modules.length; index += 1) {
      const module = modules[index]!;
      // #region debug-point D:backend-module-start
      reportDebug('D', 'src/modules/content-generation/content-generation.service.ts:executeContentRefresh:module:start', '[DEBUG] Backend begins content refresh module', { workspaceId, jobId, module, index, totalModules: modules.length });
      // #endregion
      moduleStatus[module] = { status: 'queued', goal: moduleGoals[module] };
      await repo.updateJob(workspaceId, jobId, { current_phase: module, progress: Math.round((index / modules.length) * 100), module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
      await repo.updateJob(workspaceId, jobId, { progress: Math.round((index / modules.length) * 100), module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
      if (module === 'competitors' || module === 'knowledge') {
        moduleStatus[module] = { ...moduleStatus[module] as Record<string, unknown>, status: 'running' };
        await repo.updateJob(workspaceId, jobId, { module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
        try {
          const summary = await executeManualModule(workspaceId, userId, module);
          moduleStatus[module] = { ...moduleStatus[module] as Record<string, unknown>, status: 'completed', summary };
          // #region debug-point D:backend-manual-module-complete
          reportDebug('D', 'src/modules/content-generation/content-generation.service.ts:executeContentRefresh:manual:completed', '[DEBUG] Backend completed manual content refresh module', { workspaceId, jobId, module, summary });
          // #endregion
        } catch (error) {
          moduleStatus[module] = {
            ...moduleStatus[module] as Record<string, unknown>,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          };
          // #region debug-point D:backend-manual-module-error
          reportDebug('D', 'src/modules/content-generation/content-generation.service.ts:executeContentRefresh:manual:error', '[DEBUG] Backend manual content refresh module failed', { workspaceId, jobId, module, message: error instanceof Error ? error.message : String(error) });
          // #endregion
        }
      } else {
        const agentModule: AgentModule = module === 'website' ? 'website' : module === 'seo' ? 'seo' : module === 'analytics' ? 'general' : module === 'marketing' || module === 'advertisement' || module === 'email' ? 'general' : 'general';
        const run = await startAutomaticRun(workspaceId, moduleGoals[module], agentModule, undefined, undefined, userId);
        moduleStatus[module] = { status: run ? 'running' : 'skipped', runId: run?.id ?? null, goal: moduleGoals[module] };
        await repo.updateJob(workspaceId, jobId, { progress: Math.round((index / modules.length) * 100), module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
        if (run) {
          const completedRun = await waitForRun(workspaceId, run.id, jobId, moduleStatus, module);
          if (completedRun?.status === 'completed' && completedRun.result) {
            await repo.createAsset({ workspaceId, module, title: `${module} workspace content draft`, content: completedRun.result, sourceManifest: { runId: run.id, generatedBy: 'workspace-content-refresh' } });
            moduleStatus[module] = { ...moduleStatus[module] as Record<string, unknown>, status: 'completed' };
            // #region debug-point D:backend-agent-module-complete
            reportDebug('D', 'src/modules/content-generation/content-generation.service.ts:executeContentRefresh:agent:completed', '[DEBUG] Backend completed agent content refresh module', { workspaceId, jobId, module, runId: run.id });
            // #endregion
          } else {
            moduleStatus[module] = {
              ...moduleStatus[module] as Record<string, unknown>,
              status: completedRun?.status === 'waiting_approval' ? 'blocked_by_approval' : completedRun?.status ?? 'failed',
              error: completedRun?.errorMessage ?? null,
            };
            // #region debug-point D:backend-agent-module-error
            reportDebug('D', 'src/modules/content-generation/content-generation.service.ts:executeContentRefresh:agent:error', '[DEBUG] Backend agent content refresh module failed', { workspaceId, jobId, module, runId: run.id, status: completedRun?.status ?? 'failed', errorMessage: completedRun?.errorMessage ?? null });
            // #endregion
          }
        }
      }
      await repo.updateJob(workspaceId, jobId, { progress: Math.round(((index + 1) / modules.length) * 100), module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
    }
    await repo.updateJob(workspaceId, jobId, { status: 'completed', current_phase: 'completed', progress: 100, module_status: JSON.stringify(moduleStatus), completed_at: new Date(), heartbeat_at: new Date() });
    // #region debug-point D:backend-job-complete
    reportDebug('D', 'src/modules/content-generation/content-generation.service.ts:executeContentRefresh:completed', '[DEBUG] Backend completed workspace refresh job', { workspaceId, jobId, modules });
    // #endregion
  } catch (error) {
    // #region debug-point D:backend-job-error
    reportDebug('D', 'src/modules/content-generation/content-generation.service.ts:executeContentRefresh:error', '[DEBUG] Backend workspace refresh job failed', { workspaceId, jobId, message: error instanceof Error ? error.message : String(error) });
    // #endregion
    await repo.updateJob(workspaceId, jobId, { status: 'failed', error_message: error instanceof Error ? error.message : String(error), current_phase: 'failed', completed_at: new Date(), heartbeat_at: new Date() }).catch(() => undefined);
  }
}
