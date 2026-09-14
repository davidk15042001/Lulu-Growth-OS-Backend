import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';
import { logger } from '../config/logger.js';

const supervisorGroup = 'background-workers';
const workerGroup = 'background-worker';
const instanceId = `${process.pid}-${randomUUID()}`;
const heartbeatIntervalMs = 10_000;
const supervisorStaleAfterMs = 45_000;

export type RuntimeWorkerDefinition = {
  name: string;
  required?: boolean;
  staleAfterMs?: number;
  /** Event-driven workers may remain idle without becoming unhealthy. */
  eventDriven?: boolean;
};

type WorkerSignal = {
  name: string;
  required: boolean;
  staleAfterMs: number;
  eventDriven: boolean;
  ready: boolean;
  phase: string;
  cycleCount: number;
  lastProgressAt: string;
  lastError: string | null;
  metadata: Record<string, unknown>;
};

type PersistedWorkerRow = {
  workerName: string;
  status: 'RUNNING' | 'STOPPED';
  heartbeatAt: string;
  stoppedAt: string | null;
  metadata: Record<string, unknown>;
};

let timer: NodeJS.Timeout | undefined;
let definitions: RuntimeWorkerDefinition[] = [];
const signals = new Map<string, WorkerSignal>();

function normalizedDefinition(definition: string | RuntimeWorkerDefinition): RuntimeWorkerDefinition {
  if (typeof definition === 'string') return { name: definition, required: true, staleAfterMs: supervisorStaleAfterMs, eventDriven: false };
  return {
    name: definition.name,
    required: definition.required ?? false,
    staleAfterMs: Math.max(heartbeatIntervalMs * 2, definition.staleAfterMs ?? supervisorStaleAfterMs),
    eventDriven: definition.eventDriven ?? false,
  };
}

function workerInstanceId(name: string) {
  return `${instanceId}:${name}`;
}

async function persistSupervisorHeartbeat() {
  await query(
    `INSERT INTO runtime_worker_heartbeats(
       worker_group,instance_id,status,registered_workers,heartbeat_at,stopped_at,metadata
     ) VALUES($1,$2,'RUNNING',$3,NOW(),NULL,$4::jsonb)
     ON CONFLICT(worker_group,instance_id) DO UPDATE SET
       status='RUNNING',registered_workers=EXCLUDED.registered_workers,heartbeat_at=NOW(),stopped_at=NULL,
       metadata=EXCLUDED.metadata`,
    [
      supervisorGroup,
      instanceId,
      definitions.map((worker) => worker.name),
      JSON.stringify({
        pid: process.pid,
        requiredWorkers: definitions.filter((worker) => worker.required).map((worker) => worker.name),
        workerDefinitions: definitions,
      }),
    ],
  );
}

async function persistWorkerSignal(signal: WorkerSignal, status: 'RUNNING' | 'STOPPED' = 'RUNNING') {
  await query(
    `INSERT INTO runtime_worker_heartbeats(
       worker_group,instance_id,status,registered_workers,heartbeat_at,stopped_at,metadata
     ) VALUES($1,$2,$3::varchar,$4,NOW(),$6::timestamptz,$5::jsonb)
     ON CONFLICT(worker_group,instance_id) DO UPDATE SET
       status=EXCLUDED.status,registered_workers=EXCLUDED.registered_workers,heartbeat_at=NOW(),
       stopped_at=EXCLUDED.stopped_at,metadata=EXCLUDED.metadata`,
    [
      workerGroup,
      workerInstanceId(signal.name),
      status,
      [signal.name],
      JSON.stringify({
        pid: process.pid,
        workerName: signal.name,
        required: signal.required,
        staleAfterMs: signal.staleAfterMs,
        eventDriven: signal.eventDriven,
        ready: status === 'RUNNING' && signal.ready,
        phase: signal.phase,
        cycleCount: signal.cycleCount,
        lastProgressAt: signal.lastProgressAt,
        lastError: signal.lastError,
        ...signal.metadata,
      }),
      status === 'STOPPED' ? new Date().toISOString() : null,
    ],
  );
}

function definitionFor(name: string, options?: { required?: boolean; staleAfterMs?: number; eventDriven?: boolean }) {
  const manifest = definitions.find((definition) => definition.name === name);
  return {
    required: options?.required ?? manifest?.required ?? false,
    staleAfterMs: Math.max(
      heartbeatIntervalMs * 2,
      options?.staleAfterMs ?? manifest?.staleAfterMs ?? supervisorStaleAfterMs,
    ),
    eventDriven: options?.eventDriven ?? manifest?.eventDriven ?? false,
  };
}

/** Registration must happen inside the worker's own start function. It does not
 * get refreshed by the process supervisor: only real worker cycles can do so. */
export async function markRuntimeWorkerStarted(
  name: string,
  options?: { required?: boolean; staleAfterMs?: number; eventDriven?: boolean; metadata?: Record<string, unknown> },
) {
  const definition = definitionFor(name, options);
  const now = new Date().toISOString();
  const signal: WorkerSignal = {
    name,
    ...definition,
    ready: true,
    phase: 'started',
    cycleCount: 0,
    lastProgressAt: now,
    lastError: null,
    metadata: options?.metadata ?? {},
  };
  signals.set(name, signal);
  await persistWorkerSignal(signal);
}

/** Report an actual successful poll/cycle boundary. A process heartbeat never
 * calls this on a worker's behalf. */
export async function markRuntimeWorkerProgress(
  name: string,
  progress: { phase?: string; processed?: number; metadata?: Record<string, unknown> } = {},
) {
  const existing = signals.get(name);
  const definition = definitionFor(name);
  const signal: WorkerSignal = {
    name,
    required: existing?.required ?? definition.required,
    staleAfterMs: existing?.staleAfterMs ?? definition.staleAfterMs,
    eventDriven: existing?.eventDriven ?? definition.eventDriven,
    ready: true,
    phase: progress.phase ?? 'idle',
    cycleCount: (existing?.cycleCount ?? 0) + 1,
    lastProgressAt: new Date().toISOString(),
    lastError: null,
    metadata: {
      ...(existing?.metadata ?? {}),
      ...(progress.metadata ?? {}),
      ...(progress.processed === undefined ? {} : { processed: progress.processed }),
    },
  };
  signals.set(name, signal);
  await persistWorkerSignal(signal);
}

export async function markRuntimeWorkerFailed(name: string, error: unknown) {
  const existing = signals.get(name);
  const definition = definitionFor(name);
  const signal: WorkerSignal = {
    name,
    required: existing?.required ?? definition.required,
    staleAfterMs: existing?.staleAfterMs ?? definition.staleAfterMs,
    eventDriven: existing?.eventDriven ?? definition.eventDriven,
    ready: false,
    phase: 'failed',
    cycleCount: existing?.cycleCount ?? 0,
    lastProgressAt: existing?.lastProgressAt ?? new Date().toISOString(),
    lastError: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
    metadata: existing?.metadata ?? {},
  };
  signals.set(name, signal);
  await persistWorkerSignal(signal);
}

export async function markRuntimeWorkerStopping(name: string) {
  const existing = signals.get(name);
  const definition = definitionFor(name);
  const signal: WorkerSignal = {
    name,
    required: existing?.required ?? definition.required,
    staleAfterMs: existing?.staleAfterMs ?? definition.staleAfterMs,
    eventDriven: existing?.eventDriven ?? definition.eventDriven,
    ready: false,
    phase: 'stopping',
    cycleCount: existing?.cycleCount ?? 0,
    lastProgressAt: new Date().toISOString(),
    lastError: existing?.lastError ?? null,
    metadata: existing?.metadata ?? {},
  };
  signals.set(name, signal);
  await persistWorkerSignal(signal);
}

export async function markRuntimeWorkerStopped(name: string) {
  const existing = signals.get(name);
  const definition = definitionFor(name);
  const signal: WorkerSignal = {
    name,
    required: existing?.required ?? definition.required,
    staleAfterMs: existing?.staleAfterMs ?? definition.staleAfterMs,
    eventDriven: existing?.eventDriven ?? definition.eventDriven,
    ready: false,
    phase: 'stopped',
    cycleCount: existing?.cycleCount ?? 0,
    lastProgressAt: existing?.lastProgressAt ?? new Date().toISOString(),
    lastError: existing?.lastError ?? null,
    metadata: existing?.metadata ?? {},
  };
  signals.set(name, signal);
  await persistWorkerSignal(signal, 'STOPPED').catch((error: unknown) => {
    logger.warn({ error, worker: name }, 'Worker stop state could not be persisted');
  });
}

/** Small non-blocking facade for poll workers. Health persistence must never
 * prevent the business cycle it observes from running. */
export function createRuntimeWorkerMonitor(
  name: string,
  options: { required?: boolean; staleAfterMs?: number; eventDriven?: boolean } = {},
) {
  // Keep lifecycle writes ordered. In particular, a fire-and-forget start or
  // progress write must never land after an awaited STOPPED write during a
  // fast shutdown.
  let pendingWrite: Promise<void> = Promise.resolve();
  let acceptingProgress = true;
  const reportError = (error: unknown, action: string) => {
    logger.warn({ error, worker: name }, `Runtime worker ${action} state could not be persisted`);
  };
  const enqueue = (action: string, write: () => Promise<void>) => {
    pendingWrite = pendingWrite
      .catch(() => undefined)
      .then(write)
      .catch((error: unknown) => reportError(error, action));
    return pendingWrite;
  };
  return {
    start(metadata: Record<string, unknown> = {}) {
      acceptingProgress = true;
      void enqueue('start', () => markRuntimeWorkerStarted(name, { ...options, metadata }));
    },
    progress(progress: { phase?: string; processed?: number; metadata?: Record<string, unknown> } = {}) {
      if (!acceptingProgress) return;
      void enqueue('progress', () => markRuntimeWorkerProgress(name, progress));
    },
    failed(error: unknown) {
      if (!acceptingProgress) return;
      void enqueue('failure', () => markRuntimeWorkerFailed(name, error));
    },
    async stopping() {
      acceptingProgress = false;
      await enqueue('stopping', () => markRuntimeWorkerStopping(name));
    },
    async stopped() {
      acceptingProgress = false;
      await enqueue('stop', () => markRuntimeWorkerStopped(name));
    },
  };
}

export async function startWorkerSupervisorHeartbeat(
  workers: readonly (string | RuntimeWorkerDefinition)[],
) {
  if (timer) return;
  definitions = [...new Map(workers.map((worker) => {
    const normalized = normalizedDefinition(worker);
    return [normalized.name, normalized] as const;
  })).values()].sort((left, right) => left.name.localeCompare(right.name));
  await persistSupervisorHeartbeat();
  timer = setInterval(() => {
    void persistSupervisorHeartbeat().catch((error: unknown) => logger.error({ error }, 'Worker supervisor heartbeat failed'));
  }, heartbeatIntervalMs);
  timer.unref();
}

export async function stopWorkerSupervisorHeartbeat() {
  if (timer) clearInterval(timer);
  timer = undefined;
  await query(
    `UPDATE runtime_worker_heartbeats SET status='STOPPED',stopped_at=NOW(),heartbeat_at=NOW()
     WHERE (worker_group=$1 AND instance_id=$2)
        OR (worker_group=$3 AND instance_id LIKE $4)`,
    [supervisorGroup, instanceId, workerGroup, `${instanceId}:%`],
  ).catch((error: unknown) => logger.warn({ error }, 'Worker supervisor stop state could not be persisted'));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function getWorkerSupervisorHealth() {
  const supervisor = (await query<{
    heartbeatAt: string;
    startedAt: string;
    registeredWorkers: string[];
    metadata: Record<string, unknown>;
  }>(
    `SELECT heartbeat_at AS "heartbeatAt",started_at AS "startedAt",
            registered_workers AS "registeredWorkers",metadata
       FROM runtime_worker_heartbeats
      WHERE worker_group=$1 AND instance_id=$2 AND status='RUNNING'
      LIMIT 1`,
    [supervisorGroup, instanceId],
  )).rows[0];

  const workerRows = (await query<PersistedWorkerRow>(
    `SELECT registered_workers[1] AS "workerName",status,heartbeat_at AS "heartbeatAt",
            stopped_at AS "stoppedAt",metadata
       FROM runtime_worker_heartbeats
      WHERE worker_group=$1 AND instance_id LIKE $2`,
    [workerGroup, `${instanceId}:%`],
  )).rows;

  const now = Date.now();
  const supervisorLive = Boolean(
    supervisor && now - new Date(supervisor.heartbeatAt).getTime() <= supervisorStaleAfterMs,
  );
  const metadata = objectValue(supervisor?.metadata);
  const registeredWorkers = supervisor?.registeredWorkers ?? [];
  const requiredWorkers = stringArray(metadata.requiredWorkers);
  const definitionRows = Array.isArray(metadata.workerDefinitions)
    ? metadata.workerDefinitions.map(objectValue)
    : [];

  const workers = registeredWorkers.map((name) => {
    const row = workerRows.find((entry) => entry.workerName === name);
    const workerMetadata = objectValue(row?.metadata);
    const declared = definitionRows.find((entry) => entry.name === name);
    const staleAfterMs = Number(workerMetadata.staleAfterMs ?? declared?.staleAfterMs ?? supervisorStaleAfterMs);
    const eventDriven = workerMetadata.eventDriven === true || declared?.eventDriven === true;
    const lastProgressAt = typeof workerMetadata.lastProgressAt === 'string' ? workerMetadata.lastProgressAt : null;
    const progressFresh = eventDriven || Boolean(lastProgressAt && now - new Date(lastProgressAt).getTime() <= staleAfterMs);
    const ready = Boolean(
      supervisorLive
      && row?.status === 'RUNNING'
      && workerMetadata.ready === true
      && progressFresh,
    );
    return {
      name,
      required: requiredWorkers.includes(name),
      ready,
      status: row?.status ?? 'MISSING',
      phase: typeof workerMetadata.phase === 'string' ? workerMetadata.phase : null,
      heartbeatAt: row?.heartbeatAt ?? null,
      lastProgressAt,
      staleAfterMs,
      eventDriven,
      cycleCount: Number(workerMetadata.cycleCount ?? 0),
      lastError: typeof workerMetadata.lastError === 'string' ? workerMetadata.lastError : null,
    };
  });
  const unhealthyRequiredWorkers = workers.filter((worker) => worker.required && !worker.ready).map((worker) => worker.name);

  return {
    live: supervisorLive && unhealthyRequiredWorkers.length === 0,
    supervisorLive,
    staleAfterMs: supervisorStaleAfterMs,
    instanceId: supervisor ? instanceId : null,
    heartbeatAt: supervisor?.heartbeatAt ?? null,
    startedAt: supervisor?.startedAt ?? null,
    registeredWorkers,
    requiredWorkers,
    unhealthyRequiredWorkers,
    workers,
  };
}
