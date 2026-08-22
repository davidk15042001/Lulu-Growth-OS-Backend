import { conflictError } from '../../utils/app-error.js';
import * as repo from './content-generation.repo.js';
import { startAutomaticRun } from '../agents/agent.service.js';
import * as agentRepo from '../agents/agent.repo.js';
import type { AgentModule } from '../agents/agent.capabilities.js';

const moduleGoals: Record<repo.ContentModule, string> = {
  website: '[content-generation:website] Generate reusable website architecture, page copy briefs and conversion assets from the approved workspace intelligence.',
  seo: '[content-generation:seo] Generate reusable SEO clusters, metadata briefs and editorial opportunities from the approved workspace intelligence.',
  marketing: '[content-generation:marketing] Generate reusable marketing content pillars, campaign concepts and publishing calendar assets.',
  advertisement: '[content-generation:advertisement] Generate reusable advertisement angles, headline variants and landing-page mappings without publishing campaigns.',
  email: '[content-generation:email] Generate reusable lifecycle email sequences, subject lines and CTA variants without sending messages.',
  analytics: '[content-generation:analytics] Generate measurement goals, events, KPI definitions and UTM conventions from the workspace intelligence.',
};

export async function startContentRefresh(workspaceId: string, userId: string, requestedModules: repo.ContentModule[] = [...repo.CONTENT_MODULES]) {
  const active = await repo.getActiveJob(workspaceId);
  if (active) return { job: active, reused: true };
  const job = await repo.createJob(workspaceId, userId, requestedModules);
  if (!job) throw conflictError('The workspace content refresh could not be created');
  void executeContentRefresh(workspaceId, job.id, requestedModules);
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
    moduleStatus[module] = { ...(moduleStatus[module] as Record<string, unknown>), status: run.status };
    await repo.updateJob(workspaceId, jobId, { module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { status: 'failed', errorMessage: 'Content module generation timed out' } as const;
}

async function executeContentRefresh(workspaceId: string, jobId: string, modules: repo.ContentModule[]) {
  try {
    await repo.updateJob(workspaceId, jobId, { status: 'running', current_phase: 'modules', started_at: new Date(), heartbeat_at: new Date() });
    const moduleStatus: Record<string, unknown> = {};
    for (let index = 0; index < modules.length; index += 1) {
      const module = modules[index]!;
      moduleStatus[module] = { status: 'queued', goal: moduleGoals[module] };
      await repo.updateJob(workspaceId, jobId, { current_phase: module, progress: Math.round((index / modules.length) * 100), module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
      const agentModule: AgentModule = module === 'website' ? 'website' : module === 'seo' ? 'seo' : module === 'analytics' ? 'general' : module === 'marketing' || module === 'advertisement' || module === 'email' ? 'general' : 'general';
      const run = await startAutomaticRun(workspaceId, moduleGoals[module], agentModule);
      moduleStatus[module] = { status: run ? 'running' : 'skipped', runId: run?.id ?? null, goal: moduleGoals[module] };
      await repo.updateJob(workspaceId, jobId, { progress: Math.round((index / modules.length) * 100), module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
      if (run) {
        const completedRun = await waitForRun(workspaceId, run.id, jobId, moduleStatus, module);
        if (completedRun?.status === 'completed' && completedRun.result) {
          await repo.createAsset({ workspaceId, module, title: `${module} workspace content draft`, content: completedRun.result, sourceManifest: { runId: run.id, generatedBy: 'workspace-content-refresh' } });
          moduleStatus[module] = { ...moduleStatus[module] as Record<string, unknown>, status: 'completed' };
        } else {
          moduleStatus[module] = { ...moduleStatus[module] as Record<string, unknown>, status: completedRun?.status ?? 'failed', error: completedRun?.errorMessage ?? null };
        }
      }
      await repo.updateJob(workspaceId, jobId, { progress: Math.round(((index + 1) / modules.length) * 100), module_status: JSON.stringify(moduleStatus), heartbeat_at: new Date() });
    }
    await repo.updateJob(workspaceId, jobId, { status: 'completed', current_phase: 'completed', progress: 100, module_status: JSON.stringify(moduleStatus), completed_at: new Date(), heartbeat_at: new Date() });
  } catch (error) {
    await repo.updateJob(workspaceId, jobId, { status: 'failed', error_message: error instanceof Error ? error.message : String(error), current_phase: 'failed', completed_at: new Date(), heartbeat_at: new Date() }).catch(() => undefined);
  }
}
