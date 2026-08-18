import { query } from '../../db/pool.js';
import type { AgentRun, AgentRunEvent, AgentStep } from './agent.types.js';

const runSelect = `id, workspace_id AS "workspaceId", created_by AS "createdBy", goal, status, plan,
 result, error_code AS "errorCode", error_message AS "errorMessage", started_at AS "startedAt",
 finished_at AS "finishedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
const stepSelect = `id, run_id AS "runId", workspace_id AS "workspaceId", sequence_no AS "sequenceNo",
 agent_role AS "agentRole", title, instruction, status, depends_on AS "dependsOn", tool_name AS "toolName",
 tool_input AS "toolInput", tool_output AS "toolOutput", approval_id AS "approvalId", result,
 error_code AS "errorCode", error_message AS "errorMessage", started_at AS "startedAt", finished_at AS "finishedAt",
 created_at AS "createdAt", updated_at AS "updatedAt"`;
const eventSelect = `id, run_id AS "runId", step_id AS "stepId", workspace_id AS "workspaceId",
 event_type AS "eventType", agent_role AS "agentRole", payload, created_at AS "createdAt"`;

export async function createRun(workspaceId: string, userId: string, goal: string) {
  const { rows } = await query<AgentRun>(`INSERT INTO agent_runs (workspace_id, created_by, goal)
    VALUES ($1, $2, $3) RETURNING ${runSelect}`, [workspaceId, userId, goal]);
  return rows[0];
}
export async function listRuns(workspaceId: string, limit = 50) {
  const { rows } = await query<AgentRun>(`SELECT ${runSelect} FROM agent_runs WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT $2`, [workspaceId, limit]);
  return rows;
}
export async function getRun(workspaceId: string, runId: string) {
  const { rows } = await query<AgentRun>(`SELECT ${runSelect} FROM agent_runs WHERE workspace_id=$1 AND id=$2`, [workspaceId, runId]);
  return rows[0];
}
export async function updateRun(runId: string, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  const values = keys.map((key) => patch[key]);
  const assignments = keys.map((key, index) => `${key}=$${index + 2}`).join(', ');
  const { rows } = await query<AgentRun>(`UPDATE agent_runs SET ${assignments}, updated_at=NOW() WHERE id=$1 RETURNING ${runSelect}`, [runId, ...values]);
  return rows[0];
}
export async function createSteps(steps: Array<{ runId: string; workspaceId: string; sequenceNo: number; agentRole: string; title: string; instruction: string; toolName?: string | null; toolInput?: Record<string, unknown> | null }>) {
  const created: AgentStep[] = [];
  for (const step of steps) {
    const { rows } = await query<AgentStep>(`INSERT INTO agent_run_steps (run_id, workspace_id, sequence_no, agent_role, title, instruction, tool_name, tool_input)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${stepSelect}`, [step.runId, step.workspaceId, step.sequenceNo, step.agentRole, step.title, step.instruction, step.toolName ?? null, step.toolInput ?? null]);
    if (rows[0]) created.push(rows[0]);
  }
  return created;
}
export async function listSteps(workspaceId: string, runId: string) {
  const { rows } = await query<AgentStep>(`SELECT ${stepSelect} FROM agent_run_steps WHERE workspace_id=$1 AND run_id=$2 ORDER BY sequence_no ASC`, [workspaceId, runId]);
  return rows;
}
export async function getStep(workspaceId: string, runId: string, stepId: string) {
  const { rows } = await query<AgentStep>(`SELECT ${stepSelect} FROM agent_run_steps WHERE workspace_id=$1 AND run_id=$2 AND id=$3`, [workspaceId, runId, stepId]);
  return rows[0];
}
export async function updateStep(stepId: string, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  const values = keys.map((key) => patch[key]);
  const assignments = keys.map((key, index) => `${key}=$${index + 2}`).join(', ');
  const { rows } = await query<AgentStep>(`UPDATE agent_run_steps SET ${assignments}, updated_at=NOW() WHERE id=$1 RETURNING ${stepSelect}`, [stepId, ...values]);
  return rows[0];
}
export async function addEvent(input: { runId: string; stepId?: string | null; workspaceId: string; eventType: string; agentRole?: string | null; payload?: Record<string, unknown> }) {
  const { rows } = await query<AgentRunEvent>(`INSERT INTO agent_run_events (run_id, step_id, workspace_id, event_type, agent_role, payload)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${eventSelect}`, [input.runId, input.stepId ?? null, input.workspaceId, input.eventType, input.agentRole ?? null, input.payload ?? {}]);
  return rows[0];
}
export async function listEvents(workspaceId: string, runId: string) {
  const { rows } = await query<AgentRunEvent>(`SELECT ${eventSelect} FROM agent_run_events WHERE workspace_id=$1 AND run_id=$2 ORDER BY created_at ASC`, [workspaceId, runId]);
  return rows;
}
