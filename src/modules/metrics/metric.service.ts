import { conflictError, notFoundError } from '../../utils/app-error.js';
import * as repo from './metric.repo.js';
import type {
  CreateMetricInput,
  ListMetricPointsQuery,
  MetricPointInput,
  UpdateMetricInput,
} from './metric.validator.js';

export const listMetrics = repo.listMetrics;

export async function getMetric(workspaceId: string, metricId: string) {
  const metric = await repo.findMetric(workspaceId, metricId);
  if (!metric) throw notFoundError('Metric not found');
  return metric;
}

export async function createMetric(workspaceId: string, input: CreateMetricInput) {
  try {
    const metricId = await repo.createMetric(workspaceId, input);
    if (!metricId) throw new Error('Metric insert did not return an id');
    return getMetric(workspaceId, metricId);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw conflictError('A metric with this key already exists');
    }
    throw error;
  }
}

export async function updateMetric(workspaceId: string, metricId: string, input: UpdateMetricInput) {
  try {
    if (!(await repo.updateMetric(workspaceId, metricId, input))) {
      throw notFoundError('Metric not found');
    }
    return getMetric(workspaceId, metricId);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw conflictError('A metric with this key already exists');
    }
    throw error;
  }
}

export async function archiveMetric(workspaceId: string, metricId: string) {
  if (!(await repo.archiveMetric(workspaceId, metricId))) {
    throw notFoundError('Metric not found');
  }
}

export async function insertPoints(workspaceId: string, metricId: string, points: MetricPointInput[]) {
  const inserted = await repo.insertPoints(workspaceId, metricId, points);
  if (inserted === undefined) throw notFoundError('Metric not found');
  return { inserted };
}

export const listPoints = (
  workspaceId: string,
  metricId: string,
  filters: ListMetricPointsQuery
) => repo.listPoints(workspaceId, metricId, filters);
