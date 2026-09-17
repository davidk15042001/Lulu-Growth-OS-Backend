import type { ResourceType } from '../../domain/resource-catalog.js';
import { badRequest, conflictError } from '../../utils/app-error.js';
import * as recordRepo from '../records/record.repo.js';
import * as recordService from '../records/record.service.js';
import {
  normalizePipelineState,
  pipelineKind,
  SALES_PIPELINE_STAGES,
  type SalesPipelineResourceType,
  type SalesPipelineStage,
  type SalesPipelineState,
} from './sales-pipeline.types.js';

function transitionMap(kind: keyof typeof SALES_PIPELINE_STAGES): Record<string, readonly string[]> {
  if (kind === 'lead') {
    return {
      new: ['contacted', 'qualified', 'disqualified', 'lost'],
      contacted: ['qualified', 'disqualified', 'lost'],
      qualified: ['converted', 'lost'],
      disqualified: ['new', 'lost'],
      converted: [],
      lost: ['new'],
    };
  }
  if (kind === 'opportunity') {
    return {
      open: ['qualified', 'lost'],
      qualified: ['proposal', 'lost'],
      proposal: ['negotiation', 'won', 'lost'],
      negotiation: ['won', 'lost'],
      won: [],
      lost: ['open'],
    };
  }
  return {
    open: ['in_progress', 'cancelled', 'completed'],
    in_progress: ['completed', 'cancelled'],
    completed: [],
    cancelled: ['open'],
  };
}

function isNoopTransition(current: SalesPipelineStage, target: string) {
  return current === target;
}

export type SalesPipelineRecord = recordRepo.WorkspaceRecord & { pipeline: SalesPipelineState };

function withPipeline(record: recordRepo.WorkspaceRecord): SalesPipelineRecord {
  const kind = pipelineKind(record.resourceType as SalesPipelineResourceType);
  return { ...record, pipeline: normalizePipelineState(record.data?.pipeline, kind, record.stage, record.status) };
}

export async function getPipelineRecord(workspaceId: string, resourceType: SalesPipelineResourceType, recordId: string) {
  const record = await recordService.getRecord(workspaceId, resourceType as ResourceType, recordId);
  return withPipeline(record);
}

export async function transitionRecord(
  workspaceId: string,
  resourceType: SalesPipelineResourceType,
  recordId: string,
  actorId: string,
  input: { targetState: string; expectedVersion?: number | undefined; reason?: string | null | undefined },
) {
  const current = await recordService.getRecord(workspaceId, resourceType as ResourceType, recordId);
  const kind = pipelineKind(resourceType);
  const state = normalizePipelineState(current.data?.pipeline, kind, current.stage, current.status);
  const allowed = SALES_PIPELINE_STAGES[kind] as readonly string[];
  const target = input.targetState.toLowerCase().replace(/\s+/g, '_');
  if (!allowed.includes(target)) {
    throw badRequest(`Unsupported ${kind} state: ${input.targetState}`, { allowedStates: allowed });
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
    throw conflictError(`Record changed since version ${input.expectedVersion}`);
  }
  if (!isNoopTransition(state.state, target)) {
    const allowedNext = transitionMap(kind)[state.state] ?? [];
    if (!allowedNext.includes(target)) {
      throw conflictError(`${kind} cannot transition from ${state.state} to ${target}`);
    }
  }
  const now = new Date().toISOString();
  const nextPipeline: SalesPipelineState = isNoopTransition(state.state, target)
    ? state
    : {
      ...state,
      state: target as SalesPipelineStage,
      previousState: state.state,
      transitionedAt: now,
      transitionedBy: actorId,
      transitionReason: input.reason?.trim() || null,
      stateVersion: state.stateVersion + 1,
    };
  const result = await recordService.updateRecord(workspaceId, resourceType as ResourceType, recordId, actorId, {
    expectedVersion: input.expectedVersion ?? current.version,
    stage: nextPipeline.state,
    status: kind === 'task'
      ? (nextPipeline.state === 'completed' ? 'completed' : nextPipeline.state === 'cancelled' ? 'cancelled' : 'active')
      : (['lost', 'disqualified'].includes(nextPipeline.state) ? 'closed' : nextPipeline.state === 'won' || nextPipeline.state === 'converted' ? 'won' : 'active'),
    data: { ...(current.data ?? {}), pipeline: nextPipeline },
  });
  return withPipeline(result);
}

export async function listPipelineRecords(workspaceId: string, resourceType: SalesPipelineResourceType, filters: Parameters<typeof recordRepo.listRecords>[2]) {
  const result = await recordRepo.listRecords(workspaceId, resourceType as ResourceType, filters);
  return { ...result, items: result.items.map(withPipeline) };
}
