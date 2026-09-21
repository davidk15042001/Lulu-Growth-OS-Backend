import { randomUUID } from 'node:crypto';
import { logger } from '../../config/logger.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { AppError, notFoundError } from '../../utils/app-error.js';
import { assertWorkspaceCapability, type WorkspaceActorCapabilities } from '../workspaces/workspace-authorization.service.js';
import { assertWorkspaceAutomationActive } from '../workspaces/workspace-automation.service.js';
import type { WorkspaceCapability } from '../workspaces/workspace-permissions.js';
import * as companyBrainRepo from '../company-brain/company-brain.repo.js';
import * as repo from './executive-ops.repo.js';
import type {
  ExecutiveCycleType,
  ExecutiveFinding,
  ExecutiveOperatingCycle,
  ExecutiveProposal,
} from './executive-ops.types.js';

export type ExecutiveActorAccess = Pick<WorkspaceActorCapabilities, 'capabilities'>;

type CycleTrigger = ExecutiveOperatingCycle['triggerType'];

const planOnlyRiskNote = 'Plan-only: this proposal cannot send, publish, spend, modify a provider, or change a canonical business record.';

function capabilityForFinding(finding: ExecutiveFinding): WorkspaceCapability {
  if (finding.findingType === 'financial_risk') return 'finance.read';
  if (finding.findingType === 'crm_risk') return 'crm.read';
  if (finding.findingType === 'campaign_risk') return 'advertising.read';
  if (finding.findingType === 'product_risk') return 'products.read';
  return 'agents.read';
}

function capabilityForProposal(proposal: Pick<ExecutiveProposal, 'proposalType'>, mode: 'read' | 'write'): WorkspaceCapability {
  switch (proposal.proposalType) {
    case 'finance': return mode === 'read' ? 'finance.read' : 'finance.manage';
    case 'crm': return mode === 'read' ? 'crm.read' : 'crm.manage';
    case 'product': return mode === 'read' ? 'products.read' : 'products.update';
    case 'marketing': return mode === 'read' ? 'social.read' : 'social.manage';
    case 'campaign': return mode === 'read' ? 'advertising.read' : 'advertising.manage';
    default: return mode === 'read' ? 'agents.read' : 'agents.manage';
  }
}

function canReadFinding(finding: ExecutiveFinding, access: ExecutiveActorAccess) {
  return access.capabilities.has(capabilityForFinding(finding));
}

function canReadProposal(proposal: ExecutiveProposal, access: ExecutiveActorAccess) {
  return access.capabilities.has(capabilityForProposal(proposal, 'read'));
}

function redactCycle(cycle: ExecutiveOperatingCycle, access: ExecutiveActorAccess) {
  const summary = { ...cycle.summary };
  const evidence = { ...cycle.evidence };
  const findingCounts = summary.findingCounts;
  if (findingCounts && typeof findingCounts === 'object' && !Array.isArray(findingCounts)) {
    const visibleCounts = Object.fromEntries(
      Object.entries(findingCounts as Record<string, unknown>).filter(([findingType]) => (
        access.capabilities.has(capabilityForFinding({ findingType } as ExecutiveFinding))
      )),
    );
    summary.findingCounts = visibleCounts;
    summary.findingCount = Object.values(visibleCounts).reduce<number>((total, value) => (
      total + (typeof value === 'number' ? value : 0)
    ), 0);
  }
  if (!access.capabilities.has('finance.read')) {
    delete summary.financialRiskCount;
    delete summary.overdueInvoiceCurrencyCount;
    delete evidence.finance;
  }
  if (!access.capabilities.has('crm.read')) {
    delete summary.crmRiskCount;
    delete evidence.crm;
  }
  if (!access.capabilities.has('products.read')) delete summary.productRiskCount;
  if (!access.capabilities.has('advertising.read')) delete summary.campaignRiskCount;
  if (evidence.planning && typeof evidence.planning === 'object' && !Array.isArray(evidence.planning)) {
    const planning = { ...(evidence.planning as Record<string, unknown>) };
    if (!access.capabilities.has('products.read')) delete planning.productMetricRisks;
    if (!access.capabilities.has('advertising.read')) delete planning.campaignMetricRisks;
    if (Object.keys(planning).length === 0) delete evidence.planning;
    else evidence.planning = planning;
  }
  return { ...cycle, summary, evidence };
}

function groupedCount<T extends { findingType: string }>(findings: T[]) {
  return findings.reduce<Record<string, number>>((counts, finding) => {
    counts[finding.findingType] = (counts[finding.findingType] ?? 0) + 1;
    return counts;
  }, {});
}

function boundMateriality(value: number) {
  return Math.max(0, Math.min(1, value));
}

function automaticProposalForFinding(finding: ExecutiveFinding): Omit<repo.CreateProposalInput, 'workspaceId' | 'cycleId' | 'findingId'> | null {
  if (finding.severity < 3) return null;
  switch (finding.findingType) {
    case 'financial_risk':
      return {
        proposalType: 'finance',
        title: `Prepare a receivables recovery plan: ${finding.title}`,
        objective: 'Prepare an evidence-backed, plan-only receivables recovery sequence. Identify the canonical owner, prerequisite evidence, communication approvals, and reconciliation checks. Do not send a payment reminder, change an invoice, or move funds.',
        priority: Math.min(100, finding.severity * 20),
        confidence: finding.materiality,
        expectedImpact: { objective: 'reduce_overdue_receivables_risk', sourceFindingId: finding.id },
        riskNotes: [planOnlyRiskNote],
        evidence: { sourceFindingId: finding.id, sourceFindingType: finding.findingType },
        idempotencyKey: `executive-cycle:${finding.cycleId}:finding:${finding.id}:finance-plan:v1`,
        actorType: 'system',
      };
    case 'operational_bottleneck':
      return {
        proposalType: 'operations',
        title: `Prepare an operational recovery plan: ${finding.title}`,
        objective: 'Prepare a safe, evidence-backed recovery plan for this operational bottleneck. Name the canonical owner, missing prerequisite, verification criteria, and rollback boundary. Do not retry provider work or mutate operational records.',
        priority: Math.min(100, finding.severity * 20),
        confidence: finding.materiality,
        expectedImpact: { objective: 'remove_verified_operational_blocker', sourceFindingId: finding.id },
        riskNotes: [planOnlyRiskNote],
        evidence: { sourceFindingId: finding.id, sourceFindingType: finding.findingType },
        idempotencyKey: `executive-cycle:${finding.cycleId}:finding:${finding.id}:operations-plan:v1`,
        actorType: 'system',
      };
    case 'agent_failure':
      return {
        proposalType: 'digital_employee',
        title: `Prepare a Digital Employee recovery plan: ${finding.title}`,
        objective: 'Prepare a plan-only diagnosis of the failed Digital Employee run. Classify the failure, identify evidence to inspect, and specify a safe retry or escalation criterion. Do not repeat the original action or create a provider side effect.',
        priority: Math.min(100, finding.severity * 20),
        confidence: finding.materiality,
        expectedImpact: { objective: 'restore_verified_agent_reliability', sourceFindingId: finding.id },
        riskNotes: [planOnlyRiskNote],
        evidence: { sourceFindingId: finding.id, sourceFindingType: finding.findingType },
        idempotencyKey: `executive-cycle:${finding.cycleId}:finding:${finding.id}:employee-plan:v1`,
        actorType: 'system',
      };
    case 'crm_risk':
      return {
        proposalType: 'crm',
        title: `Prepare a CRM recovery plan: ${finding.title}`,
        objective: 'Prepare a plan-only CRM recovery brief from the canonical follow-up or opportunity evidence. Identify ownership, the next safe customer-contact approval, record-quality checks, success criteria, and any later escalation. Do not change a CRM record, send a message, create a task, or sync a provider.',
        priority: Math.min(100, finding.severity * 20),
        confidence: finding.materiality,
        expectedImpact: { objective: 'recover_verified_crm_pipeline_risk', sourceFindingId: finding.id },
        riskNotes: [planOnlyRiskNote],
        evidence: { sourceFindingId: finding.id, sourceFindingType: finding.findingType },
        idempotencyKey: `executive-cycle:${finding.cycleId}:finding:${finding.id}:crm-plan:v1`,
        actorType: 'system',
      };
    case 'product_risk':
      return {
        proposalType: 'product',
        title: `Prepare a product improvement plan: ${finding.title}`,
        objective: 'Prepare a plan-only product improvement brief from the measured product metric decline. Identify the canonical product owner, missing customer or quality evidence, proposed validation work, success criteria, and any later approval packet. Do not alter a product, price, catalog, inventory record, or external commerce provider.',
        priority: Math.min(100, finding.severity * 20),
        confidence: finding.materiality,
        expectedImpact: { objective: 'validate_and_reverse_product_metric_decline', sourceFindingId: finding.id },
        riskNotes: [planOnlyRiskNote],
        evidence: { sourceFindingId: finding.id, sourceFindingType: finding.findingType },
        idempotencyKey: `executive-cycle:${finding.cycleId}:finding:${finding.id}:product-plan:v1`,
        actorType: 'system',
      };
    case 'campaign_risk':
      return {
        proposalType: 'campaign',
        title: `Prepare a campaign recovery plan: ${finding.title}`,
        objective: 'Prepare a plan-only campaign recovery brief from the measured marketing or acquisition metric decline. Name the audience, channel, attribution evidence, budget and compliance prerequisites, success criteria, and approval packet required before any later launch. Do not create, edit, publish, pause, or spend on a campaign.',
        priority: Math.min(100, finding.severity * 20),
        confidence: finding.materiality,
        expectedImpact: { objective: 'validate_and_reverse_campaign_metric_decline', sourceFindingId: finding.id },
        riskNotes: [planOnlyRiskNote],
        evidence: { sourceFindingId: finding.id, sourceFindingType: finding.findingType },
        idempotencyKey: `executive-cycle:${finding.cycleId}:finding:${finding.id}:campaign-plan:v1`,
        actorType: 'system',
      };
    case 'open_signal':
      return {
        proposalType: 'strategy',
        title: `Prepare a strategic response plan: ${finding.title}`,
        objective: 'Prepare a plan-only strategic response grounded in the persisted Company Brain signal. State assumptions, expected evidence, accountable domain owner, and the approvals required for any later execution. Do not create campaigns, messages, or provider changes.',
        priority: Math.min(100, finding.severity * 20),
        confidence: finding.materiality,
        expectedImpact: { objective: 'evaluate_material_company_signal', sourceFindingId: finding.id },
        riskNotes: [planOnlyRiskNote],
        evidence: { sourceFindingId: finding.id, sourceFindingType: finding.findingType },
        idempotencyKey: `executive-cycle:${finding.cycleId}:finding:${finding.id}:strategy-plan:v1`,
        actorType: 'system',
      };
    default:
      return null;
  }
}

function planningMetricFinding(input: {
  workspaceId: string;
  cycleId: string;
  fact: repo.PlanningMetricRiskFact;
}): repo.CreateFindingInput {
  const domain = input.fact.metricDomain.toLowerCase();
  const isProduct = domain === 'product';
  const ratio = Math.abs(Number(input.fact.changeRatio));
  const materiality = Number.isFinite(ratio) ? boundMateriality(Math.max(0.35, ratio)) : 0.35;
  const severity = Number.isFinite(ratio) && ratio >= 0.5 ? 4 : 3;
  const type = isProduct ? 'product_risk' : 'campaign_risk';
  const subject = isProduct ? 'product_metric' : 'campaign_metric';
  const scope = isProduct ? 'product' : 'marketing or acquisition';
  return {
    workspaceId: input.workspaceId,
    cycleId: input.cycleId,
    sourceKey: `metric-decline:${input.fact.metricId}:${input.fact.sourceMetricPointId}`,
    findingType: type,
    subjectType: subject,
    subjectId: input.fact.metricId,
    severity,
    materiality,
    title: `Measured ${scope} metric decline: ${input.fact.metricName}`,
    description: `${input.fact.metricName} declined from ${input.fact.previousValue} to ${input.fact.baselineValue} ${input.fact.metricUnit} between its two most recent measured points. This is a measured trend signal, not a causal diagnosis.`,
    evidence: {
      metricId: input.fact.metricId,
      metricKey: input.fact.metricKey,
      metricDomain: input.fact.metricDomain,
      metricUnit: input.fact.metricUnit,
      sourceMetricPointId: input.fact.sourceMetricPointId,
      previousValue: input.fact.previousValue,
      baselineValue: input.fact.baselineValue,
      previousRecordedAt: input.fact.previousRecordedAt,
      baselineRecordedAt: input.fact.baselineRecordedAt,
      changeRatio: input.fact.changeRatio,
      source: 'canonical_metrics',
    },
  };
}

function crmPipelineRiskFinding(input: {
  workspaceId: string;
  cycleId: string;
  fact: repo.CrmPipelineRiskFact;
}): repo.CreateFindingInput {
  const overdueFollowUp = input.fact.riskType === 'overdue_follow_up';
  const severity = input.fact.ageDays >= (overdueFollowUp ? 14 : 30) ? 4 : 3;
  const materiality = boundMateriality(0.4 + Math.min(0.4, input.fact.ageDays / 100));
  const riskLabel = overdueFollowUp ? 'Overdue CRM follow-up' : 'Stalled CRM opportunity';
  const description = overdueFollowUp
    ? `${input.fact.name} is a canonical ${input.fact.resourceType} follow-up that was due ${input.fact.ageDays} day${input.fact.ageDays === 1 ? '' : 's'} before the cycle data cutoff. This is a workflow-age signal, not a recommendation to contact a customer automatically.`
    : `${input.fact.name} is a canonical ${input.fact.resourceType} opportunity with no recorded update for ${input.fact.ageDays} days before the cycle data cutoff. This is a workflow-age signal, not a probability-of-close prediction.`;
  return {
    workspaceId: input.workspaceId,
    cycleId: input.cycleId,
    sourceKey: `crm-pipeline:${input.fact.riskType}:${input.fact.recordId}:${input.fact.updatedAt}`,
    findingType: 'crm_risk',
    subjectType: input.fact.resourceType,
    subjectId: input.fact.recordId,
    severity,
    materiality,
    title: `${riskLabel}: ${input.fact.name}`,
    description,
    evidence: {
      riskType: input.fact.riskType,
      recordId: input.fact.recordId,
      resourceType: input.fact.resourceType,
      stage: input.fact.stage,
      status: input.fact.status,
      dueAt: input.fact.dueAt,
      updatedAt: input.fact.updatedAt,
      ageDays: input.fact.ageDays,
      source: 'canonical_workspace_records',
    },
  };
}

function cycleDataGaps(input: { metricCoverage: { defined: number; withTwoPoints: number }; forecastCandidateCount: number }) {
  const gaps: Array<Record<string, unknown>> = [];
  if (input.metricCoverage.defined === 0) {
    gaps.push({ code: 'NO_METRIC_DEFINITIONS', domain: 'metrics', message: 'No workspace metric definitions are available for forecasting.' });
  } else if (input.metricCoverage.withTwoPoints === 0) {
    gaps.push({ code: 'INSUFFICIENT_METRIC_HISTORY', domain: 'metrics', message: 'Metrics exist but none has two measured points for a transparent trend forecast.' });
  } else if (input.forecastCandidateCount < input.metricCoverage.withTwoPoints) {
    gaps.push({ code: 'METRIC_TIMELINE_GAPS', domain: 'metrics', message: 'Some metrics have insufficient or non-increasing timestamps for forecasting.' });
  }
  return gaps;
}

async function appendExecutiveEvent(input: {
  workspaceId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}) {
  try {
    await appendDomainEvent({
      workspaceId: input.workspaceId,
      type: input.type,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload,
      metadata: { source: 'executive-ops' },
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    // The executive row is already durable. Domain-event delivery remains
    // observable and retryable independently; it must not erase a completed
    // executive report after its evidence has been persisted.
    logger.warn({ error, workspaceId: input.workspaceId, aggregateId: input.aggregateId }, 'Executive domain event could not be appended');
  }
}

async function rawCycleDetail(workspaceId: string, cycleId: string) {
  const cycle = await repo.getCycle(workspaceId, cycleId);
  if (!cycle) throw notFoundError('Executive operating cycle not found');
  const [findings, forecasts, proposals] = await Promise.all([
    repo.listFindings(workspaceId, 100, cycleId),
    repo.listForecasts(workspaceId, 100, cycleId),
    repo.listProposalsForCycle(workspaceId, cycleId, 100),
  ]);
  return { cycle, findings, forecasts, proposals };
}

function filterCycleDetail(
  detail: Awaited<ReturnType<typeof rawCycleDetail>>,
  access: ExecutiveActorAccess,
) {
  return {
    cycle: redactCycle(detail.cycle, access),
    findings: detail.findings.filter((finding) => canReadFinding(finding, access)),
    forecasts: detail.forecasts,
    proposals: detail.proposals.filter((proposal) => canReadProposal(proposal, access)),
  };
}

export async function runCycle(input: {
  workspaceId: string;
  cycleType: ExecutiveCycleType;
  triggerType: CycleTrigger;
  startedBy?: string | null;
  timezone?: string;
  access?: ExecutiveActorAccess;
}) {
  await assertWorkspaceAutomationActive(input.workspaceId);
  const timezone = input.timezone ?? await repo.getWorkspaceTimezone(input.workspaceId);
  const window = await repo.getCycleWindow(input.cycleType, timezone);
  const claimed = await repo.claimOperatingCycle({
    workspaceId: input.workspaceId,
    cycleType: input.cycleType,
    triggerType: input.triggerType,
    timezone,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    ...(input.startedBy ? { startedBy: input.startedBy } : {}),
  });
  if (!claimed.claimed) {
    const detail = await rawCycleDetail(input.workspaceId, claimed.cycle.id);
    return input.access ? filterCycleDetail(detail, input.access) : detail;
  }

  try {
    const dataCutoffAt = claimed.cycle.dataCutoffAt;
    const [signals, bottlenecks, failedRuns, overdueExposure, crmPipelineRisks, metricCoverage, forecastCandidates, planningMetricRisks, calibrated] = await Promise.all([
      repo.listOpenSignals(input.workspaceId, 24, dataCutoffAt),
      repo.listOperationalBottlenecks(input.workspaceId, 24, dataCutoffAt),
      repo.listRecentFailedAgentRuns(input.workspaceId, 24, dataCutoffAt),
      repo.listOverdueInvoiceExposure(input.workspaceId, dataCutoffAt),
      repo.listCrmPipelineRisks(input.workspaceId, 24, dataCutoffAt),
      repo.getMetricCoverage(input.workspaceId, dataCutoffAt),
      repo.listForecastCandidates(input.workspaceId, 32, dataCutoffAt),
      repo.listDecliningPlanningMetrics(input.workspaceId, 24, dataCutoffAt),
      repo.calibrateDueForecasts(input.workspaceId, 50),
    ]);

    const findingInputs: repo.CreateFindingInput[] = [
      ...signals.map((signal) => ({
        workspaceId: input.workspaceId,
        cycleId: claimed.cycle.id,
        sourceKey: `brain-signal:${signal.signalId}`,
        findingType: 'open_signal',
        subjectType: 'company_brain_signal',
        subjectId: signal.signalId,
        severity: signal.severity,
        materiality: signal.materiality,
        title: `Open Company Brain signal: ${signal.signalType}`,
        description: signal.explanation,
        evidence: { signalId: signal.signalId, signalType: signal.signalType, detectedAt: signal.detectedAt, source: 'company_brain' },
      })),
      ...bottlenecks.map((task) => ({
        workspaceId: input.workspaceId,
        cycleId: claimed.cycle.id,
        sourceKey: `brain-task:${task.taskId}:${task.status}`,
        findingType: 'operational_bottleneck',
        subjectType: 'company_brain_task',
        subjectId: task.taskId,
        severity: task.priority >= 80 ? 4 : 3,
        materiality: boundMateriality(0.45 + (task.priority / 200)),
        title: `Blocked operational task: ${task.title}`,
        description: task.blockedReason ?? task.errorCode ?? 'A Company Brain task is blocked or failed and needs an evidence-backed recovery plan.',
        evidence: {
          taskId: task.taskId, missionId: task.missionId, status: task.status, priority: task.priority,
          blockedReason: task.blockedReason, errorCode: task.errorCode, updatedAt: task.updatedAt, source: 'company_brain',
        },
      })),
      ...failedRuns.map((run) => ({
        workspaceId: input.workspaceId,
        cycleId: claimed.cycle.id,
        sourceKey: `agent-run:${run.runId}:failed`,
        findingType: 'agent_failure',
        subjectType: 'agent_run',
        subjectId: run.runId,
        severity: 3,
        materiality: 0.6,
        title: `Recent Digital Employee failure${run.module ? ` in ${run.module}` : ''}`,
        description: 'A recent agent run ended in a failed state. The persisted run evidence must be reviewed before any retry.',
        evidence: { runId: run.runId, module: run.module, errorCode: run.errorCode, updatedAt: run.updatedAt, source: 'agent_runs' },
      })),
      ...overdueExposure.map((exposure) => ({
        workspaceId: input.workspaceId,
        cycleId: claimed.cycle.id,
        sourceKey: `overdue-invoices:${exposure.currency}`,
        findingType: 'financial_risk',
        subjectType: 'invoice_receivables',
        severity: 4,
        materiality: boundMateriality(0.45 + (exposure.invoiceCount * 0.08)),
        title: `Overdue invoice exposure in ${exposure.currency}`,
        description: `${exposure.invoiceCount} canonical invoice${exposure.invoiceCount === 1 ? '' : 's'} remain overdue or past due in this currency. Amounts are intentionally not mixed across currencies.`,
        evidence: {
          currency: exposure.currency, invoiceCount: exposure.invoiceCount, amountDue: exposure.amountDue,
          oldestDueDate: exposure.oldestDueDate, source: 'canonical_invoices',
        },
      })),
      ...crmPipelineRisks.map((fact) => crmPipelineRiskFinding({
        workspaceId: input.workspaceId,
        cycleId: claimed.cycle.id,
        fact,
      })),
      ...planningMetricRisks.map((fact) => planningMetricFinding({
        workspaceId: input.workspaceId,
        cycleId: claimed.cycle.id,
        fact,
      })),
    ];

    const [findings, forecastIds] = await Promise.all([
      repo.upsertFindings(findingInputs),
      repo.createForecasts(forecastCandidates.map((candidate) => ({
        ...candidate,
        workspaceId: input.workspaceId,
        cycleId: claimed.cycle.id,
        confidence: 0.2,
        assumptions: [
          'This is a transparent two-point trend projection, not a causal forecast.',
          'The next interval is assumed to match the elapsed time between the two most recent measurements.',
        ],
        evidence: {
          metricId: candidate.metricId,
          sourceMetricPointId: candidate.sourceMetricPointId,
          baselineRecordedAt: candidate.baselineRecordedAt,
          method: 'two_point_trend',
        },
      }))),
    ]);

    const automaticProposals = findings
      .map(automaticProposalForFinding)
      .filter((proposal): proposal is NonNullable<typeof proposal> => proposal !== null);
    await Promise.all(automaticProposals.map((proposal) => {
      const findingId = String(proposal.evidence.sourceFindingId ?? '');
      return repo.createProposal({
        ...proposal,
        workspaceId: input.workspaceId,
        cycleId: claimed.cycle.id,
        findingId,
      });
    }));

    const dataGaps = cycleDataGaps({ metricCoverage, forecastCandidateCount: forecastCandidates.length });
    const completed = await repo.completeOperatingCycle({
      workspaceId: input.workspaceId,
      cycleId: claimed.cycle.id,
      summary: {
        evidenceStatus: 'measured_and_derived',
        findingCount: findings.length,
        findingCounts: groupedCount(findings),
        financialRiskCount: findings.filter((finding) => finding.findingType === 'financial_risk').length,
        crmRiskCount: findings.filter((finding) => finding.findingType === 'crm_risk').length,
        productRiskCount: findings.filter((finding) => finding.findingType === 'product_risk').length,
        campaignRiskCount: findings.filter((finding) => finding.findingType === 'campaign_risk').length,
        forecastCount: forecastIds.length,
        calibratedForecastCount: calibrated.length,
        proposedPlanCount: automaticProposals.length,
        metricDefinitionCount: metricCoverage.defined,
        metricsWithTwoPointsCount: metricCoverage.withTwoPoints,
        overdueInvoiceCurrencyCount: overdueExposure.length,
      },
      evidence: {
        companyBrain: { openSignals: signals.length, blockedOrFailedTasks: bottlenecks.length },
        agentRuns: { recentFailures: failedRuns.length },
        metrics: { definitions: metricCoverage.defined, withTwoPoints: metricCoverage.withTwoPoints, forecastCandidates: forecastCandidates.length },
        finance: { overdueExposureByCurrency: overdueExposure },
        crm: {
          overdueFollowUps: crmPipelineRisks.filter((fact) => fact.riskType === 'overdue_follow_up').length,
          stalledOpportunities: crmPipelineRisks.filter((fact) => fact.riskType === 'stalled_opportunity').length,
        },
        planning: {
          productMetricRisks: planningMetricRisks.filter((fact) => fact.metricDomain.toLowerCase() === 'product').length,
          campaignMetricRisks: planningMetricRisks.filter((fact) => fact.metricDomain.toLowerCase() !== 'product').length,
        },
      },
      dataGaps,
    });
    if (!completed) throw new Error('Executive cycle could not transition to completed');
    await appendExecutiveEvent({
      workspaceId: input.workspaceId,
      type: 'executive.cycle.completed',
      aggregateType: 'executive_operating_cycle',
      aggregateId: completed.id,
      payload: { cycleType: completed.cycleType, findingCount: findings.length, forecastCount: forecastIds.length },
      idempotencyKey: `executive-cycle:${completed.id}:completed:v1`,
    });
    const detail = await rawCycleDetail(input.workspaceId, completed.id);
    return input.access ? filterCycleDetail(detail, input.access) : detail;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Executive cycle failed';
    await repo.failOperatingCycle({
      workspaceId: input.workspaceId,
      cycleId: claimed.cycle.id,
      code: 'EXECUTIVE_CYCLE_FAILED',
      message,
    });
    throw error;
  }
}

export async function getOverview(workspaceId: string, access: ExecutiveActorAccess) {
  const [schedules, daily, weekly, findings, forecasts, proposals, scenarios, learning] = await Promise.all([
    repo.listSchedules(workspaceId),
    repo.getLatestCycle(workspaceId, 'daily'),
    repo.getLatestCycle(workspaceId, 'weekly'),
    repo.listFindings(workspaceId, 50),
    repo.listForecasts(workspaceId, 40),
    repo.listProposals(workspaceId, 50),
    repo.listScenarios(workspaceId, 20),
    repo.listLearning(workspaceId, 30),
  ]);
  const visibleFindings = findings.filter((finding) => canReadFinding(finding, access));
  const visibleProposals = proposals.filter((proposal) => canReadProposal(proposal, access));
  return {
    generatedAt: new Date().toISOString(),
    schedules,
    latestCycles: {
      daily: daily ? redactCycle(daily, access) : null,
      weekly: weekly ? redactCycle(weekly, access) : null,
    },
    findings: visibleFindings,
    forecasts,
    proposals: visibleProposals,
    scenarios,
    learning,
    summary: {
      visibleFindingCount: visibleFindings.length,
      visibleProposalCount: visibleProposals.length,
      forecastCount: forecasts.length,
      scenarioCount: scenarios.length,
      learningRecordCount: learning.length,
    },
  };
}

export async function getCycleDetail(workspaceId: string, cycleId: string, access: ExecutiveActorAccess) {
  return filterCycleDetail(await rawCycleDetail(workspaceId, cycleId), access);
}

export const listCycles = repo.listCycles;

export async function listFindings(workspaceId: string, limit: number, access: ExecutiveActorAccess) {
  return (await repo.listFindings(workspaceId, limit)).filter((finding) => canReadFinding(finding, access));
}

export const listForecasts = repo.listForecasts;

export async function listScenarios(workspaceId: string, limit: number) {
  return repo.listScenarios(workspaceId, limit);
}

export async function getScenario(workspaceId: string, scenarioId: string) {
  const scenario = await repo.getScenario(workspaceId, scenarioId);
  if (!scenario) throw notFoundError('Executive scenario not found');
  return scenario;
}

export async function createScenario(input: {
  workspaceId: string;
  cycleId: string;
  name: string;
  description: string;
  assumptions: unknown[];
  projections: Array<{ forecastId: string; adjustmentPercent: number }>;
  createdBy: string;
}) {
  const cycle = await repo.getCycle(input.workspaceId, input.cycleId);
  if (!cycle) throw notFoundError('Executive operating cycle not found');
  const scenario = await repo.createScenario(input);
  if (!scenario) throw notFoundError('Executive scenario references an unavailable cycle or forecast');
  return getScenario(input.workspaceId, scenario.id);
}

async function assertProposalWriteCapability(workspaceId: string, userId: string, proposal: Pick<ExecutiveProposal, 'proposalType'>) {
  await assertWorkspaceCapability({
    workspaceId,
    userId,
    capability: capabilityForProposal(proposal, 'write'),
  });
}

export async function createProposal(input: {
  workspaceId: string;
  cycleId?: string | null;
  findingId?: string | null;
  proposalType: ExecutiveProposal['proposalType'];
  title: string;
  objective: string;
  priority: number;
  confidence: number;
  expectedImpact: Record<string, unknown>;
  riskNotes: unknown[];
  evidence: Record<string, unknown>;
  idempotencyKey?: string | null;
  createdBy: string;
}) {
  await assertProposalWriteCapability(input.workspaceId, input.createdBy, input);
  if (input.cycleId && !await repo.getCycle(input.workspaceId, input.cycleId)) {
    throw notFoundError('Executive operating cycle not found');
  }
  if (input.findingId && !await repo.getFinding(input.workspaceId, input.findingId)) {
    throw notFoundError('Executive finding not found');
  }
  const result = await repo.createProposal({
    ...input,
    idempotencyKey: input.idempotencyKey ?? `executive-proposal:${randomUUID()}`,
    actorType: 'human',
    actorId: input.createdBy,
  });
  await appendExecutiveEvent({
    workspaceId: input.workspaceId,
    type: 'executive.proposal.created',
    aggregateType: 'executive_proposal',
    aggregateId: result.proposal.id,
    payload: { proposalType: result.proposal.proposalType, created: result.created },
    idempotencyKey: `executive-proposal:${result.proposal.id}:created:v1`,
  });
  return result;
}

export async function listProposals(
  workspaceId: string,
  limit: number,
  access: ExecutiveActorAccess,
  status?: ExecutiveProposal['status'],
) {
  return (await repo.listProposals(workspaceId, limit, status)).filter((proposal) => canReadProposal(proposal, access));
}

export async function getProposal(workspaceId: string, proposalId: string, access: ExecutiveActorAccess) {
  const proposal = await repo.getProposal(workspaceId, proposalId);
  if (!proposal || !canReadProposal(proposal, access)) throw notFoundError('Executive proposal not found');
  const events = await repo.listProposalEvents(workspaceId, proposalId, 100);
  return { proposal, events };
}

export async function dispatchApprovedProposal(workspaceId: string, proposalId: string) {
  const proposal = await repo.getProposal(workspaceId, proposalId);
  if (!proposal) throw notFoundError('Executive proposal not found');
  if (proposal.companyBrainMissionId || proposal.status === 'dispatched') return proposal;
  if (proposal.status !== 'approved') return proposal;
  await assertWorkspaceAutomationActive(workspaceId);

  const observation = await companyBrainRepo.upsertObservation({
    workspaceId,
    sourceType: 'user',
    sourceKey: `executive-proposal:${proposal.id}`,
    subjectType: 'executive_proposal',
    subjectId: proposal.id,
    eventType: 'executive.proposal.approved',
    summary: `Approved plan-only ${proposal.proposalType} proposal: ${proposal.title}`,
    evidence: {
      proposalId: proposal.id,
      proposalType: proposal.proposalType,
      executionMode: proposal.executionMode,
      expectedImpact: proposal.expectedImpact,
    },
    trustScore: 1,
  });
  const signal = await companyBrainRepo.upsertSignal({
    workspaceId,
    observationId: observation.id,
    signalType: `executive_${proposal.proposalType}_proposal`,
    severity: Math.max(1, Math.min(5, Math.ceil(proposal.priority / 20))),
    materiality: proposal.confidence,
    explanation: proposal.objective,
    evidence: { proposalId: proposal.id, proposalType: proposal.proposalType, executionMode: 'plan_only', source: 'executive_ops' },
  });
  const mission = await companyBrainRepo.createMissionFromSignal({
    workspaceId,
    signalId: signal.id,
    title: `Prepare approved ${proposal.proposalType} plan: ${proposal.title}`,
    objective: `${proposal.objective}\n\nExecution boundary: produce a verified plan and any required approval packet only. Do not send, publish, spend, change a provider, or mutate canonical business records.`,
    priority: proposal.priority,
  });
  if (!mission) throw new Error('Approved executive proposal could not create a Company Brain mission');
  const attached = await repo.attachProposalMission({
    workspaceId,
    proposalId: proposal.id,
    signalId: signal.id,
    missionId: mission.mission.id,
    taskId: mission.task?.id ?? null,
  });
  if (!attached) throw new Error('Approved executive proposal could not be linked to its Company Brain mission');
  await appendExecutiveEvent({
    workspaceId,
    type: 'executive.proposal.dispatched',
    aggregateType: 'executive_proposal',
    aggregateId: attached.id,
    payload: { proposalType: attached.proposalType, missionId: attached.companyBrainMissionId, executionMode: attached.executionMode },
    idempotencyKey: `executive-proposal:${attached.id}:dispatched:v1`,
  });
  return attached;
}

export async function decideProposal(input: {
  workspaceId: string;
  proposalId: string;
  expectedVersion: number;
  decision: 'approve' | 'reject';
  reason?: string | null;
  actorId: string;
}) {
  const existing = await repo.getProposal(input.workspaceId, input.proposalId);
  if (!existing) throw notFoundError('Executive proposal not found');
  await assertProposalWriteCapability(input.workspaceId, input.actorId, existing);
  if (input.decision === 'approve') await assertWorkspaceAutomationActive(input.workspaceId);
  const result = await repo.decideProposal(input);
  if (!result) throw notFoundError('Executive proposal not found');
  if (!result.changed) {
    if (result.reason === 'version_conflict') {
      throw new AppError(409, 'EXECUTIVE_PROPOSAL_VERSION_CONFLICT', 'The proposal changed before this decision could be applied.', { currentVersion: result.proposal.version });
    }
    throw new AppError(409, 'EXECUTIVE_PROPOSAL_NOT_DECIDABLE', 'This proposal is no longer awaiting a decision.', { status: result.proposal.status });
  }
  await appendExecutiveEvent({
    workspaceId: input.workspaceId,
    type: `executive.proposal.${input.decision}d`,
    aggregateType: 'executive_proposal',
    aggregateId: result.proposal.id,
    payload: { proposalType: result.proposal.proposalType, status: result.proposal.status },
    idempotencyKey: `executive-proposal:${result.proposal.id}:${input.decision}:v1`,
  });
  if (input.decision === 'reject') return result.proposal;

  try {
    return await dispatchApprovedProposal(input.workspaceId, result.proposal.id);
  } catch (error) {
    // Approval is durable even if the deferred plan hand-off has a temporary
    // infrastructure issue. The worker retries APPROVED proposals; expose a
    // safe status rather than claiming that a Digital Employee started.
    logger.error({ error, workspaceId: input.workspaceId, proposalId: result.proposal.id }, 'Approved executive proposal is awaiting dispatch retry');
    return result.proposal;
  }
}

export async function verifyProposalOutcome(input: {
  workspaceId: string;
  proposalId: string;
  expectedVersion: number;
  outcome: string;
  evidence: Record<string, unknown>;
  confidence: number;
  idempotencyKey?: string | null;
  actorId: string;
}) {
  const proposal = await repo.getProposal(input.workspaceId, input.proposalId);
  if (!proposal) throw notFoundError('Executive proposal not found');
  await assertProposalWriteCapability(input.workspaceId, input.actorId, proposal);
  await assertWorkspaceCapability({ workspaceId: input.workspaceId, userId: input.actorId, capability: 'quality.review' });
  const result = await repo.verifyProposalOutcome({
    workspaceId: input.workspaceId,
    proposalId: input.proposalId,
    expectedVersion: input.expectedVersion,
    outcome: input.outcome,
    evidence: input.evidence,
    confidence: input.confidence,
    sourceKey: input.idempotencyKey ?? `executive-proposal:${input.proposalId}:outcome:${randomUUID()}`,
    actorId: input.actorId,
  });
  if (!result) throw notFoundError('Executive proposal not found');
  if (!result.changed) {
    if (!result.reason && result.learning) return { ...result, replayed: true };
    if (result.reason === 'version_conflict') {
      throw new AppError(409, 'EXECUTIVE_PROPOSAL_VERSION_CONFLICT', 'The proposal changed before this outcome could be recorded.', { currentVersion: result.proposal.version });
    }
    if (result.reason === 'mission_incomplete') {
      throw new AppError(409, 'EXECUTIVE_PROPOSAL_MISSION_INCOMPLETE', 'The plan outcome cannot be verified until its Company Brain mission is completed.');
    }
    if (result.reason === 'mission_missing') {
      throw new AppError(409, 'EXECUTIVE_PROPOSAL_MISSION_REQUIRED', 'The plan outcome cannot be verified without its Company Brain mission.');
    }
    if (result.reason === 'source_key_conflict') {
      throw new AppError(409, 'EXECUTIVE_PROPOSAL_OUTCOME_KEY_CONFLICT', 'The supplied outcome idempotency key belongs to a different proposal.');
    }
    throw new AppError(409, 'EXECUTIVE_PROPOSAL_NOT_OUTCOME_READY', 'The proposal is not in a state where an outcome can be verified.', { status: result.proposal.status });
  }
  await appendExecutiveEvent({
    workspaceId: input.workspaceId,
    type: 'executive.proposal.outcome_verified',
    aggregateType: 'executive_proposal',
    aggregateId: result.proposal.id,
    payload: { learningId: result.learning?.id ?? null, proposalType: result.proposal.proposalType, confidence: input.confidence },
    idempotencyKey: `executive-proposal:${result.proposal.id}:outcome:${result.learning?.id ?? 'unknown'}:v1`,
  });
  return { ...result, replayed: false };
}

export async function dispatchApprovedProposals(limit: number) {
  const proposals = await repo.listApprovedProposals(limit);
  let dispatched = 0;
  for (const proposal of proposals) {
    try {
      const result = await dispatchApprovedProposal(proposal.workspaceId, proposal.id);
      if (result.status === 'dispatched') dispatched += 1;
    } catch (error) {
      logger.warn({ error, workspaceId: proposal.workspaceId, proposalId: proposal.id }, 'Executive proposal dispatch will retry later');
    }
  }
  return { inspected: proposals.length, dispatched };
}

export const calibrateDueForecasts = repo.calibrateDueForecasts;

export async function saveSchedule(input: {
  workspaceId: string;
  cycleType: ExecutiveCycleType;
  timezone: string;
  hourOfDay: number;
  weekday: number;
  active: boolean;
}) {
  return repo.saveSchedule(input);
}

export async function listSchedules(workspaceId: string) {
  return repo.listSchedules(workspaceId);
}
