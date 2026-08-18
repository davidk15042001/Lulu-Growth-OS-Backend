import { AppError, notFoundError } from '../../utils/app-error.js';
import { createApproval } from '../approvals/approval.repo.js';
import { getOpenAIResponsesClient, isAiGenerationConfigured } from '../ai/openai.service.js';
import * as repo from './agent.repo.js';
import type { AgentRole, AgentTool } from './agent.types.js';

const tools = new Map<string, AgentTool>();

tools.set('workspace_snapshot', {
  name: 'workspace_snapshot', version: '1.0.0', risk: 'read',
  description: 'Reads the current workspace context for analysis.',
  execute: async ({ workspaceId }) => ({ workspaceId, source: 'workspace_context', capturedAt: new Date().toISOString() }),
});

const pipeline: Array<{ role: AgentRole; title: string; instruction: string; toolName?: string }> = [
  { role: 'planner', title: 'Understand the objective', instruction: 'Clarify the goal, constraints, expected outcome and required approvals.' },
  { role: 'analyst', title: 'Collect workspace signals', instruction: 'Inspect available live workspace records and identify relevant evidence.', toolName: 'workspace_snapshot' },
  { role: 'strategist', title: 'Propose coordinated actions', instruction: 'Convert evidence into prioritized recommendations with risks and dependencies.' },
  { role: 'reviewer', title: 'Review the proposed outcome', instruction: 'Check evidence, uncertainty, permissions, safety and whether an action needs approval.' },
];

async function event(input: Parameters<typeof repo.addEvent>[0]) {
  return repo.addEvent(input);
}

async function planRun(runId: string, workspaceId: string, goal: string) {
  await repo.updateRun(runId, { status: 'planning', started_at: new Date() });
  await event({ runId, workspaceId, eventType: 'run.planning_started', agentRole: 'planner', payload: { goal } });
  const steps = await repo.createSteps(pipeline.map((step, index) => ({
    runId, workspaceId, sequenceNo: index + 1, agentRole: step.role, title: step.title,
    instruction: `${step.instruction} User goal: ${goal}`, toolName: step.toolName ?? null,
  })));
  await repo.updateRun(runId, { status: 'running', plan: { version: 1, agents: pipeline.map((item) => item.role), steps: steps.map((item) => ({ id: item.id, role: item.agentRole, title: item.title })) } });
  await event({ runId, workspaceId, eventType: 'run.planned', agentRole: 'planner', payload: { stepCount: steps.length } });
  return steps;
}

async function executeStep(runId: string, workspaceId: string, userId: string, step: Awaited<ReturnType<typeof repo.listSteps>>[number]) {
  await repo.updateStep(step.id, { status: 'running', started_at: new Date() });
  await event({ runId, stepId: step.id, workspaceId, eventType: 'step.started', agentRole: step.agentRole, payload: { title: step.title } });
  const tool = step.toolName ? tools.get(step.toolName) : undefined;
  if (step.toolName && !tool) throw new AppError(500, 'AGENT_TOOL_NOT_REGISTERED', `Tool ${step.toolName} is not registered`);
  if (tool && tool.risk !== 'read') {
    const approval = await createApproval(workspaceId, userId, {
      actionType: `agent_tool:${tool.name}`, title: `Approve ${tool.name}`, description: step.instruction,
      payload: { runId, stepId: step.id, toolName: tool.name, toolInput: step.toolInput ?? {} },
    });
    if (!approval) throw new AppError(500, 'AGENT_APPROVAL_CREATION_FAILED', 'The approval request could not be created');
    await repo.updateStep(step.id, { status: 'waiting_approval', approval_id: approval.id });
    await repo.updateRun(runId, { status: 'waiting_approval' });
    await event({ runId, stepId: step.id, workspaceId, eventType: 'step.waiting_approval', agentRole: 'executor', payload: { approvalId: approval.id, toolName: tool.name } });
    return { waiting: true };
  }
  const toolOutput = tool ? await tool.execute(step.toolInput ?? {}, { workspaceId, userId }) : { acknowledged: true, role: step.agentRole, instruction: step.instruction };
  await repo.updateStep(step.id, { status: 'completed', tool_output: toolOutput, result: toolOutput, finished_at: new Date() });
  await event({ runId, stepId: step.id, workspaceId, eventType: 'step.completed', agentRole: step.agentRole, payload: toolOutput });
  return { waiting: false, output: toolOutput };
}

async function executeRun(runId: string, workspaceId: string, userId: string, goal: string) {
  try {
    const steps = await planRun(runId, workspaceId, goal);
    const outputs: Record<string, unknown>[] = [];
    for (const step of steps) {
      const result = await executeStep(runId, workspaceId, userId, step);
      if (result.waiting) return;
      outputs.push({ stepId: step.id, output: result.output });
    }
    let finalResult: Record<string, unknown> = { goal, outputs, completedBy: ['planner', 'analyst', 'strategist', 'reviewer'] };
    if (isAiGenerationConfigured()) {
      const response = await getOpenAIResponsesClient().create({
        model: process.env.OPENAI_MODEL,
        instructions: 'Synthesize the coordinated agent outputs into a concise business result. Return plain text.',
        input: [{ role: 'user', content: JSON.stringify(finalResult) }], store: false,
      });
      finalResult = { ...finalResult, summary: response.output_text?.trim() ?? null };
    }
    await repo.updateRun(runId, { status: 'completed', result: finalResult, finished_at: new Date() });
    await event({ runId, workspaceId, eventType: 'run.completed', agentRole: 'reviewer', payload: finalResult });
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError(500, 'AGENT_RUN_FAILED', error instanceof Error ? error.message : 'Agent run failed');
    await repo.updateRun(runId, { status: 'failed', error_code: appError.code, error_message: appError.message, finished_at: new Date() });
    await event({ runId, workspaceId, eventType: 'run.failed', payload: { code: appError.code, message: appError.message } });
  }
}

export async function startRun(workspaceId: string, userId: string, goal: string) {
  const run = await repo.createRun(workspaceId, userId, goal);
  if (!run) throw new AppError(500, 'AGENT_RUN_CREATION_FAILED', 'The agent run could not be created');
  void executeRun(run.id, workspaceId, userId, goal);
  return run;
}
export async function listRuns(workspaceId: string) { return repo.listRuns(workspaceId); }
export async function getRunDetails(workspaceId: string, runId: string) {
  const run = await repo.getRun(workspaceId, runId);
  if (!run) throw notFoundError('Agent run not found');
  const [steps, events] = await Promise.all([repo.listSteps(workspaceId, runId), repo.listEvents(workspaceId, runId)]);
  return { run, steps, events };
}
export async function cancelRun(workspaceId: string, runId: string) {
  const run = await repo.getRun(workspaceId, runId);
  if (!run) throw notFoundError('Agent run not found');
  await repo.updateRun(runId, { status: 'cancelled', finished_at: new Date() });
  await event({ runId, workspaceId, eventType: 'run.cancelled', payload: {} });
  return repo.getRun(workspaceId, runId);
}
export async function approveStep(workspaceId: string, runId: string, stepId: string) {
  const step = await repo.getStep(workspaceId, runId, stepId);
  if (!step) throw notFoundError('Agent step not found');
  await repo.updateStep(stepId, { status: 'pending', approval_id: null });
  await repo.updateRun(runId, { status: 'running' });
  return getRunDetails(workspaceId, runId);
}
