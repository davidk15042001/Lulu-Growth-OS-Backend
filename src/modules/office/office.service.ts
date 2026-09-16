import * as repo from './office.repo.js';
import type { OfficeControlAction, OfficeEmployeeRow, OfficeWorkItemStatus } from './office.types.js';
import { notFoundError } from '../../utils/app-error.js';
import * as companyBrain from '../company-brain/company-brain.service.js';
import {
  canSeeEmployee,
  canSeeTimelineItem,
  canSeeWorkItem,
  redactTimelineItem,
  redactWorkItem,
  type OfficeActorAccess,
} from './office.visibility.js';

function currentWorkItem(row: OfficeEmployeeRow) {
  if (!row.currentWorkItemId || !row.currentWorkItemStatus) return null;
  return {
    id: row.currentWorkItemId,
    title: row.currentWorkItemTitle,
    objective: row.currentWorkItemObjective,
    status: row.currentWorkItemStatus,
    version: row.currentWorkItemVersion,
    sourceType: row.currentWorkItemSourceType,
    relatedObject: row.currentWorkItemRelatedObjectType && row.currentWorkItemRelatedObjectId
      ? { type: row.currentWorkItemRelatedObjectType, id: row.currentWorkItemRelatedObjectId }
      : null,
  };
}

function employeeSummary(row: OfficeEmployeeRow) {
  return {
    id: row.employeeId,
    key: row.employeeKey,
    name: row.employeeName,
    title: row.roleTitle,
    description: row.employeeDescription,
    availability: row.availability,
    status: row.status,
    sourceAgentIds: row.sourceAgentIds,
    sourceModules: row.sourceModules,
    currentWorkItem: currentWorkItem(row),
    workSummary: {
      active: row.activeWorkCount,
      completedToday: row.completedTodayCount,
      failed: row.failedWorkCount,
    },
    lastActivityAt: row.lastActivityAt,
  };
}

export async function getOverview(workspaceId: string, timelineLimit: number, access: OfficeActorAccess) {
  const allRows = await repo.listOfficeEmployees(workspaceId);
  const rows = allRows.filter((row) => canSeeEmployee(row, access));
  const visibleEmployeeIds = rows.map((row) => row.employeeId);
  const [workSummary, rawTimeline, brain] = await Promise.all([
    repo.getOfficeSummary(workspaceId, visibleEmployeeIds),
    repo.listOfficeTimeline({ workspaceId, employeeIds: visibleEmployeeIds, limit: timelineLimit * 4 }),
    companyBrain.overview(workspaceId, Math.min(12, Math.max(5, timelineLimit))),
  ]);
  const timeline = rawTimeline
    .filter((item) => canSeeTimelineItem(item, access))
    .map(redactTimelineItem)
    .slice(0, timelineLimit);
  const departments = new Map<string, {
    id: string; key: string; name: string; description: string; sortOrder: number;
    employees: ReturnType<typeof employeeSummary>[];
  }>();
  for (const row of rows) {
    const department = departments.get(row.departmentId) ?? {
      id: row.departmentId,
      key: row.departmentKey,
      name: row.departmentName,
      description: row.departmentDescription,
      sortOrder: row.departmentSortOrder,
      employees: [],
    };
    const summary = employeeSummary(row);
    if (summary.currentWorkItem && !canSeeWorkItem({ relatedObjectType: summary.currentWorkItem.relatedObject?.type ?? null }, access)) {
      summary.currentWorkItem = null;
    }
    department.employees.push(summary);
    departments.set(row.departmentId, department);
  }
  return {
    generatedAt: new Date().toISOString(),
    // The timeline endpoint is cursor-based recent history, not a calendar-day
    // report. Expose that scope explicitly so clients cannot truthfully label
    // an unbounded page of events as "today".
    timelineScope: 'recent' as const,
    summary: {
      departmentCount: departments.size,
      employeeCount: rows.length,
      activeEmployees: rows.filter((row) => row.status !== 'IDLE' && row.status !== 'OFFLINE').length,
      workingEmployees: rows.filter((row) => row.status === 'WORKING' || row.status === 'COLLABORATING').length,
      waitingEmployees: rows.filter((row) => row.status === 'WAITING' || row.status === 'WAITING_FOR_APPROVAL').length,
      attentionEmployees: rows.filter((row) => row.status === 'ERROR' || row.status === 'WAITING_FOR_APPROVAL').length,
      ...workSummary,
    },
    departments: [...departments.values()].sort((left, right) => left.sortOrder - right.sortOrder),
    timeline,
    companyBrain: brain,
  };
}

export async function getEmployeeDetail(workspaceId: string, employeeId: string, access: OfficeActorAccess) {
  const [{ employee, capabilities }, work, recentTimeline] = await Promise.all([
    repo.getOfficeEmployee(workspaceId, employeeId),
    repo.listEmployeeWork({ workspaceId, employeeId, limit: 25, offset: 0 }),
    repo.listOfficeTimeline({ workspaceId, employeeId, limit: 30 }),
  ]);
  if (!canSeeEmployee(employee, access)) throw notFoundError('Digital employee not found');
  const summary = employeeSummary(employee);
  const visibleWork = work.items.filter((item) => canSeeWorkItem(item, access)).map(redactWorkItem);
  const visibleTimeline = recentTimeline.filter((item) => canSeeTimelineItem(item, access)).map(redactTimelineItem);
  return {
    employee: {
      ...summary,
      department: {
        id: employee.departmentId,
        key: employee.departmentKey,
        name: employee.departmentName,
      },
    },
    capabilities,
    currentWorkItem: visibleWork.find((item) => item.id === employee.currentWorkItemId) ?? null,
    workSummary: summary.workSummary,
    recentTimeline: visibleTimeline,
  };
}

function visibleWorkItem<T extends { availableControls?: unknown }>(item: T, canControl: boolean): T {
  return canControl ? item : { ...item, availableControls: [] };
}

export async function getEmployeeDetailForActor(
  workspaceId: string,
  employeeId: string,
  access: OfficeActorAccess,
  canControl: boolean,
) {
  const detail = await getEmployeeDetail(workspaceId, employeeId, access);
  return {
    ...detail,
    canControl,
    currentWorkItem: detail.currentWorkItem
      ? visibleWorkItem(detail.currentWorkItem, canControl)
      : null,
  };
}

export async function getEmployeeWork(input: {
  workspaceId: string; employeeId: string; status?: OfficeWorkItemStatus | undefined; limit: number; offset: number;
  access: OfficeActorAccess;
  canControl?: boolean | undefined;
}) {
  const { canControl = false, access, ...query } = input;
  const employee = await repo.getOfficeEmployee(input.workspaceId, input.employeeId);
  if (!canSeeEmployee(employee.employee, access)) throw notFoundError('Digital employee not found');
  const result = await repo.listEmployeeWork(query);
  const items = result.items.filter((item) => canSeeWorkItem(item, access));
  return {
    ...result,
    total: items.length,
    canControl,
    items: items.map(redactWorkItem).map((item) => visibleWorkItem(item, canControl)),
  };
}

export async function getTimeline(input: {
  workspaceId: string; employeeId?: string | undefined; before?: string | undefined; limit: number;
  access: OfficeActorAccess;
}) {
  const rows = await repo.listOfficeEmployees(input.workspaceId);
  const visibleRows = rows.filter((row) => canSeeEmployee(row, input.access));
  if (input.employeeId && !visibleRows.some((row) => row.employeeId === input.employeeId)) {
    throw notFoundError('Digital employee not found');
  }
  const items = (await repo.listOfficeTimeline({
    workspaceId: input.workspaceId,
    employeeId: input.employeeId,
    employeeIds: visibleRows.map((row) => row.employeeId),
    before: input.before,
    limit: input.limit * 4,
  })).filter((item) => canSeeTimelineItem(item, input.access)).map(redactTimelineItem).slice(0, input.limit);
  return { items, nextCursor: items.length === input.limit ? items.at(-1)?.occurredAt ?? null : null };
}

export function controlWorkItem(input: {
  workspaceId: string; workItemId: string; action: OfficeControlAction; actorId: string;
  expectedVersion: number; idempotencyKey: string; reason?: string | undefined;
}) {
  return repo.controlWorkItem(input);
}

export { createOfficeWorkItem, addWorkItemDependency } from './office.repo.js';
