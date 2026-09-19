import { conflictError } from '../../utils/app-error.js';
import * as repo from './content-generation.repo.js';
import { cancelRun, startAutomaticRun } from '../agents/agent.service.js';
import * as agentRepo from '../agents/agent.repo.js';
import type { AgentModule } from '../agents/agent.capabilities.js';
import * as onboardingService from '../onboarding/onboarding.service.js';
import * as aiProfileService from '../onboarding/onboarding.ai-profile.service.js';
import { assertWorkspaceAutomationActive } from '../workspaces/workspace-automation.service.js';

const ACTIVE_JOB_STALE_MS = 2 * 60 * 1000;

const moduleGoals: Record<repo.ContentModule, string> = {
  website: '[content-generation:website] Generate reusable website architecture, page copy briefs and conversion assets from verified workspace intelligence.',
  seo: '[content-generation:seo] Generate reusable SEO clusters, metadata briefs and editorial opportunities from verified workspace intelligence.',
  marketing: '[content-generation:marketing] Generate reusable marketing content pillars, campaign concepts and publishing calendar assets.',
  advertisement: '[content-generation:advertisement] Generate reusable advertisement angles, headline variants and landing-page mappings without publishing campaigns.',
  email: '[content-generation:email] Generate reusable lifecycle email sequences, subject lines and CTA variants without sending messages.',
  analytics: '[content-generation:analytics] Generate measurement goals, events, KPI definitions and UTM conventions from the workspace intelligence.',
  competitors: '[content-generation:competitors] Discover and refresh the top competitors for the workspace using the latest business context.',
  knowledge: '[content-generation:knowledge] Refresh the AI knowledge draft including positioning, customer segments, and competitor comparison.',
};

export async function startContentRefresh(workspaceId: string, userId: string, requestedModules: repo.ContentModule[] = [...repo.CONTENT_MODULES]) {
  await assertWorkspaceAutomationActive(workspaceId);
  const active = await repo.getActiveJob(workspaceId);
  const heartbeatAt = active?.heartbeatAt ? Date.parse(active.heartbeatAt) : NaN;
  const updatedAt = active?.updatedAt ? Date.parse(active.updatedAt) : NaN;
  const lastSeenAt = Number.isFinite(heartbeatAt) ? heartbeatAt : updatedAt;
  const staleActiveJob = active && Number.isFinite(lastSeenAt) && Date.now() - lastSeenAt > ACTIVE_JOB_STALE_MS;
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

export async function cancelContentRefresh(workspaceId: string, jobId: string, userId: string) {
  const job = await repo.getJob(workspaceId, jobId);
  if (!job) return null;
  if (['completed', 'failed', 'cancelled'].includes(String(job.status))) return job;
  const cancelled = await repo.cancelJob(workspaceId, jobId);
  const statuses = job.moduleStatus && typeof job.moduleStatus === 'object' ? job.moduleStatus as Record<string, unknown> : {};
  const current = typeof job.currentPhase === 'string' ? statuses[job.currentPhase] : null;
  const runId = current && typeof current === 'object' && typeof (current as Record<string, unknown>).runId === 'string'
    ? String((current as Record<string, unknown>).runId)
    : null;
  if (runId) await cancelRun(workspaceId, runId, userId).catch(() => undefined);
  return cancelled;
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
      await agentRepo.releaseLegacyApprovalWait(workspaceId, runId);
      moduleStatus[module] = { ...(moduleStatus[module] as Record<string, unknown>), status: 'recovering', runId };
      await repo.updateJob(workspaceId, jobId, { module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
      continue;
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
    await assertWorkspaceAutomationActive(workspaceId);
    await repo.updateJob(workspaceId, jobId, { status: 'running', current_phase: 'modules', started_at: new Date(), heartbeat_at: new Date() });
    const moduleStatus: Record<string, unknown> = {};
    for (let index = 0; index < modules.length; index += 1) {
      const currentJob = await repo.getJob(workspaceId, jobId);
      if (currentJob?.status === 'cancelled') return;
      await assertWorkspaceAutomationActive(workspaceId);
      const module = modules[index]!;
      moduleStatus[module] = { status: 'queued', goal: moduleGoals[module] };
      await repo.updateJob(workspaceId, jobId, { current_phase: module, progress: Math.round((index / modules.length) * 100), module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
      await repo.updateJob(workspaceId, jobId, { progress: Math.round((index / modules.length) * 100), module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
      if (module === 'competitors' || module === 'knowledge') {
        moduleStatus[module] = { ...moduleStatus[module] as Record<string, unknown>, status: 'running' };
        await repo.updateJob(workspaceId, jobId, { module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
        try {
          const summary = await executeManualModule(workspaceId, userId, module);
          moduleStatus[module] = { ...moduleStatus[module] as Record<string, unknown>, status: 'completed', summary };
        } catch (error) {
          moduleStatus[module] = {
            ...moduleStatus[module] as Record<string, unknown>,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          };
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
          } else {
            moduleStatus[module] = {
              ...moduleStatus[module] as Record<string, unknown>,
              status: completedRun?.status ?? 'failed',
              error: completedRun?.errorMessage ?? null,
            };
          }
        }
      }
      await repo.updateJob(workspaceId, jobId, { progress: Math.round(((index + 1) / modules.length) * 100), module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
    }
    await repo.updateJob(workspaceId, jobId, { status: 'completed', current_phase: 'completed', progress: 100, module_status: JSON.stringify(moduleStatus), completed_at: new Date(), heartbeat_at: new Date() });
  } catch (error) {
    await repo.updateJob(workspaceId, jobId, { status: 'failed', error_message: error instanceof Error ? error.message : String(error), current_phase: 'failed', completed_at: new Date(), heartbeat_at: new Date() }).catch(() => undefined);
  }
}
