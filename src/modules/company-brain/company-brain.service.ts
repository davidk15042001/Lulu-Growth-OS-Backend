import type { DomainEvent } from '../../events/domain-event.types.js';
import * as repo from './company-brain.repo.js';
import { AppError, notFoundError } from '../../utils/app-error.js';
import * as metricRepo from '../metrics/metric.repo.js';

const MARKET_LEADERSHIP_NORTH_STAR = 'Become the number-one autonomous business operating system in the market.';

const SCORECARD_CATEGORIES = [
  { key: 'customer', label: 'Customer', patterns: [/customer/i, /retention/i, /churn/i, /csat/i, /nps/i, /support/i, /satisfaction/i, /lifetime/i] },
  { key: 'product', label: 'Product', patterns: [/product/i, /quality/i, /uptime/i, /reliability/i, /adoption/i, /feature/i, /error/i] },
  { key: 'intelligence', label: 'Intelligence', patterns: [/decision/i, /hallucination/i, /research/i, /forecast/i, /confidence/i, /outcome/i, /reasoning/i] },
  { key: 'growth', label: 'Growth', patterns: [/revenue/i, /arr/i, /growth/i, /acquisition/i, /market/i, /conversion/i, /active/i] },
  { key: 'economics', label: 'Economics', patterns: [/margin/i, /cost/i, /efficiency/i, /profit/i, /revenue/i, /liquidity/i, /unit/i] },
  { key: 'trust', label: 'Trust', patterns: [/security/i, /privacy/i, /policy/i, /incident/i, /compliance/i, /data_quality/i, /risk/i] },
  { key: 'innovation', label: 'Innovation', patterns: [/experiment/i, /release/i, /improvement/i, /innovation/i, /velocity/i] },
] as const;

function scorecardCategoryForMetric(metric: metricRepo.MetricDefinition) {
  const haystack = `${metric.key} ${metric.name} ${metric.domain} ${metric.source ?? ''}`;
  return SCORECARD_CATEGORIES.find((category) => category.patterns.some((pattern) => pattern.test(haystack)))?.key ?? 'intelligence';
}

async function buildMarketLeadershipScorecard(workspaceId: string) {
  const metrics = await metricRepo.listMetrics(workspaceId);
  const categories = SCORECARD_CATEGORIES.map((category) => {
    const categoryMetrics = metrics.filter((metric) => scorecardCategoryForMetric(metric) === category.key);
    const measured = categoryMetrics.filter((metric) => metric.latestValue !== null);
    return {
      key: category.key,
      label: category.label,
      status: measured.length > 0 ? 'measured' as const : categoryMetrics.length > 0 ? 'defined' as const : 'unavailable' as const,
      metricCount: categoryMetrics.length,
      measuredCount: measured.length,
      metrics: categoryMetrics.slice(0, 12).map((metric) => ({
        key: metric.key,
        name: metric.name,
        domain: metric.domain,
        unit: metric.unit,
        value: metric.latestValue,
        recordedAt: metric.latestRecordedAt,
        source: metric.source,
        evidenceStatus: metric.latestValue === null ? 'unavailable' as const : 'measured' as const,
      })),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    northStar: MARKET_LEADERSHIP_NORTH_STAR,
    methodology: 'Categories are grouped from workspace-defined metrics. Lulu never invents a score when verified measurements are missing.',
    categories,
    totals: {
      metricCount: metrics.length,
      measuredCount: metrics.filter((metric) => metric.latestValue !== null).length,
      unavailableCount: metrics.filter((metric) => metric.latestValue === null).length,
    },
  };
}

export async function observeDomainEvent(event: DomainEvent) {
  const result = await repo.observeDomainEvent(event);
  if (!result) return null;
  return result;
}

export async function overview(workspaceId: string, limit: number) {
  const [counts, signals, missions, decisions, learning, scorecard] = await Promise.all([
    repo.counts(workspaceId),
    repo.listSignals(workspaceId, limit),
    repo.listMissions(workspaceId, limit),
    repo.listDecisions(workspaceId, limit),
    repo.listLearning(workspaceId, limit),
    buildMarketLeadershipScorecard(workspaceId),
  ]);
  return { generatedAt: new Date().toISOString(), counts, signals, missions, decisions, learning, scorecard };
}

export const scorecard = buildMarketLeadershipScorecard;

export const listSignals = repo.listSignals;
export const listMissions = repo.listMissions;
export const listDecisions = repo.listDecisions;

export async function createMission(input: {
  workspaceId: string; signalId: string; title?: string; objective?: string; priority: number; createdBy: string;
}) {
  const signal = await repo.getSignal(input.workspaceId, input.signalId);
  if (!signal) throw notFoundError('Brain signal not found');
  const title = input.title ?? `Investigate ${signal.signalType.replaceAll('_', ' ')}`;
  const objective = input.objective ?? signal.explanation;
  const result = await repo.createMissionFromSignal({ ...input, title, objective });
  if (!result) throw notFoundError('Brain signal not found');
  return result;
}

export async function updateMission(workspaceId: string, missionId: string, status: string, outcome?: Record<string, unknown>) {
  const mission = await repo.updateMission(workspaceId, missionId, status, outcome);
  if (!mission) throw notFoundError('Brain mission not found');
  return mission;
}

export const createDecision = repo.createDecision;
export const listTasksForMission = repo.listTasksForMission;
export const getTask = repo.getTask;
export const getTaskGraph = repo.getTaskGraph;
export const listLearning = repo.listLearning;

export async function createTask(input: Parameters<typeof repo.createTask>[0]) {
  const result = await repo.createTask(input);
  if (!result) throw notFoundError('Company Brain mission, parent task, or employee not found');
  return result;
}

export async function addTaskDependency(input: Parameters<typeof repo.addTaskDependency>[0]) {
  try {
    const result = await repo.addTaskDependency(input);
    if (!result) throw notFoundError('Company Brain task or dependency not found');
    return result;
  } catch (error) {
    if (error instanceof Error && error.message.includes('would create a cycle')) {
      throw new AppError(409, 'BRAIN_TASK_DEPENDENCY_CYCLE', error.message);
    }
    throw error;
  }
}

export async function updateTask(input: Parameters<typeof repo.updateTask>[0]) {
  const task = await repo.updateTask(input);
  if (!task) throw notFoundError('Company Brain task not found');
  return task;
}

export const recordLearning = repo.recordLearning;
