import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import type { DomainEvent } from '../../events/domain-event.types.js';
import * as service from './company-brain.service.js';
import * as repo from './company-brain.repo.js';

const eventTypes = Object.values(DOMAIN_EVENT_TYPES).filter((value) => !value.startsWith('brain.'));
const learningEventTypes = new Set<string>([
  DOMAIN_EVENT_TYPES.AGENT_RUN_COMPLETED,
  DOMAIN_EVENT_TYPES.AGENT_RUN_FAILED,
  DOMAIN_EVENT_TYPES.QUALITY_OUTCOME_OBSERVED,
  DOMAIN_EVENT_TYPES.QUALITY_FEEDBACK_RECORDED,
]);
const terminalRunEventTypes = new Set<string>([
  DOMAIN_EVENT_TYPES.AGENT_RUN_COMPLETED,
  DOMAIN_EVENT_TYPES.AGENT_RUN_FAILED,
  DOMAIN_EVENT_TYPES.AGENT_RUN_CANCELLED,
]);

export function registerCompanyBrainEventHandler() {
  registerDomainEventHandler({
    name: 'company-brain-observer.v1',
    eventTypes,
    async handle(event: DomainEvent) {
      const result = await service.observeDomainEvent(event);
      if (!result) return undefined;
      const task = event.workspaceId && event.aggregateType === 'agent_run'
        ? await repo.getTaskForAgentRun(event.workspaceId, event.aggregateId ?? '')
        : null;
      if (task && event.workspaceId && event.aggregateId && terminalRunEventTypes.has(event.type)) {
        const payload = event.payload ?? {};
        const code = typeof payload.code === 'string' ? payload.code : null;
        const message = typeof payload.message === 'string' ? payload.message : null;
        const blocked = event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_FAILED
          && (payload.blocked === true || code === 'AGENT_PREREQUISITE_REQUIRED');
        await repo.updateTask({
          workspaceId: event.workspaceId,
          taskId: task.id,
          agentRunId: event.aggregateId,
          status: event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_COMPLETED ? 'COMPLETED' : event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_CANCELLED ? 'CANCELLED' : blocked ? 'BLOCKED' : 'FAILED',
          result: event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_COMPLETED ? payload : null,
          blockedReason: blocked ? code : null,
          errorCode: event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_COMPLETED ? null : code,
          errorMessage: event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_COMPLETED ? null : message,
          confidence: event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_COMPLETED ? 0.9 : blocked ? 0.85 : 0.5,
          actorType: 'system',
          actorId: 'company-brain.observer',
        });
        const decisionText = event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_COMPLETED
          ? 'The agent execution completed and the canonical Company Brain task was marked completed.'
          : event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_CANCELLED
            ? 'The agent execution was cancelled and the canonical Company Brain task remains cancelled.'
            : blocked
              ? 'The agent execution was blocked by a missing prerequisite; the task remains paused and will not be retried automatically.'
              : 'The agent execution failed; the canonical Company Brain task remains paused so no duplicate side effect is replayed.';
        await repo.recordEventDecision({
          workspaceId: event.workspaceId,
          signalId: result.signal.id,
          missionId: task.missionId,
          sourceEventId: event.id,
          decisionType: `agent_run.${event.type}`,
          decision: decisionText,
          confidence: event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_COMPLETED ? 0.9 : blocked ? 0.85 : event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_CANCELLED ? 0.8 : 0.5,
          rationale: 'Decision derived from the persisted terminal event and canonical task state; it does not claim an external side effect beyond the recorded result.',
          evidence: { taskId: task.id, runId: event.aggregateId, eventType: event.type, code, message, taskStatus: event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_COMPLETED ? 'COMPLETED' : blocked ? 'BLOCKED' : event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_CANCELLED ? 'CANCELLED' : 'FAILED' },
          actorId: 'company-brain.observer',
        });
      }
      const learning = event.workspaceId && learningEventTypes.has(event.type)
        ? await service.recordLearning({
          workspaceId: event.workspaceId,
          taskId: task?.id ?? null,
          sourceEventId: event.id,
          outcomeType: event.type,
          outcome: event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_FAILED
            ? 'The persisted execution failed and is retained as a negative learning signal until verified recovery.'
            : 'A persisted execution or quality outcome was recorded for future calibration.',
          evidence: { eventType: event.type, aggregateType: event.aggregateType, aggregateId: event.aggregateId },
          confidence: event.type === DOMAIN_EVENT_TYPES.AGENT_RUN_FAILED ? 0.85 : 0.9,
          verified: event.type !== DOMAIN_EVENT_TYPES.AGENT_RUN_FAILED,
          actorType: 'system',
        })
        : null;
      return { observationId: result.observation.id, signalId: result.signal.id, missionId: result.mission?.mission.id ?? null, learningId: learning?.id ?? null };
    },
  });
}
