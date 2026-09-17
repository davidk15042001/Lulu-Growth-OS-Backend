import type { ResourceType } from '../../domain/resource-catalog.js';

export const SALES_PIPELINE_RESOURCE_TYPES = [
  'crm_leads',
  'sales_leads',
  'crm_deals',
  'opportunities',
  'sales_deals',
  'sales_opportunities',
  'growth_opportunities',
  'crm_tasks',
  'sales_tasks',
] as const satisfies readonly ResourceType[];

export type SalesPipelineResourceType = (typeof SALES_PIPELINE_RESOURCE_TYPES)[number];
export type SalesPipelineKind = 'lead' | 'opportunity' | 'task';

export const SALES_PIPELINE_STAGES = {
  lead: ['new', 'contacted', 'qualified', 'disqualified', 'converted', 'lost'],
  opportunity: ['open', 'qualified', 'proposal', 'negotiation', 'won', 'lost'],
  task: ['open', 'in_progress', 'completed', 'cancelled'],
} as const;

export type SalesPipelineStage = (typeof SALES_PIPELINE_STAGES)[SalesPipelineKind][number];

export type SalesPipelineState = {
  kind: SalesPipelineKind;
  state: SalesPipelineStage;
  previousState: SalesPipelineStage | null;
  transitionedAt: string | null;
  transitionedBy: string | null;
  transitionReason: string | null;
  stateVersion: number;
};

export function pipelineKind(resourceType: SalesPipelineResourceType): SalesPipelineKind {
  if (resourceType.includes('task')) return 'task';
  if (resourceType.includes('lead')) return 'lead';
  return 'opportunity';
}

export function initialPipelineState(kind: SalesPipelineKind, stage: string | null, status: string): SalesPipelineState {
  const allowed = SALES_PIPELINE_STAGES[kind] as readonly string[];
  const candidate = (stage ?? status).trim().toLowerCase().replace(/\s+/g, '_');
  const state = (allowed.includes(candidate) ? candidate : allowed[0]) as SalesPipelineStage;
  return {
    kind,
    state,
    previousState: null,
    transitionedAt: null,
    transitionedBy: null,
    transitionReason: null,
    stateVersion: 0,
  };
}

export function normalizePipelineState(value: unknown, kind: SalesPipelineKind, stage: string | null, status: string): SalesPipelineState {
  const fallback = initialPipelineState(kind, stage, status);
  if (!value || typeof value !== 'object') return fallback;
  const input = value as Partial<SalesPipelineState>;
  const allowed = SALES_PIPELINE_STAGES[kind] as readonly string[];
  const state = typeof input.state === 'string' && allowed.includes(input.state) ? input.state as SalesPipelineStage : fallback.state;
  const previousState = typeof input.previousState === 'string' && allowed.includes(input.previousState)
    ? input.previousState as SalesPipelineStage
    : null;
  return {
    kind,
    state,
    previousState,
    transitionedAt: typeof input.transitionedAt === 'string' ? input.transitionedAt : null,
    transitionedBy: typeof input.transitionedBy === 'string' ? input.transitionedBy : null,
    transitionReason: typeof input.transitionReason === 'string' ? input.transitionReason : null,
    stateVersion: typeof input.stateVersion === 'number' && Number.isInteger(input.stateVersion) && input.stateVersion >= 0
      ? input.stateVersion
      : fallback.stateVersion,
  };
}
