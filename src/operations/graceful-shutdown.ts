export class GracefulShutdownTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Graceful shutdown exceeded ${timeoutMs}ms`);
    this.name = 'GracefulShutdownTimeoutError';
  }
}

export function createIdempotentShutdown<T>(operation: (signal: string) => Promise<T>) {
  let activeShutdown: Promise<T> | null = null;
  return (signal: string) => {
    if (activeShutdown) return activeShutdown;
    try {
      activeShutdown = operation(signal);
    } catch (error) {
      activeShutdown = Promise.reject(error);
    }
    return activeShutdown;
  };
}

export async function withGracefulShutdownDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new GracefulShutdownTimeoutError(timeoutMs)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type RuntimeDrainPlan = {
  /** Stop accepting requests immediately, but resolve only after in-flight HTTP requests drain. */
  closeHttpIntake: () => Promise<void>;
  /** Quiesce durable event delivery before downstream consumers reject new work. */
  stopDomainRuntime: () => Promise<void>;
  stopWorkers: () => Promise<void>;
  stopSupervisor: () => Promise<void>;
  closePool: () => Promise<void>;
};

export async function drainRuntime(plan: RuntimeDrainPlan) {
  const errors: unknown[] = [];
  let httpDrain: Promise<void>;
  try {
    httpDrain = plan.closeHttpIntake().catch((error: unknown) => { errors.push(error); });
  } catch (error) {
    errors.push(error);
    httpDrain = Promise.resolve();
  }
  const settle = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  };
  await settle(plan.stopDomainRuntime);
  await settle(plan.stopWorkers);
  await settle(plan.stopSupervisor);
  await httpDrain;
  await settle(plan.closePool);
  if (errors.length > 0) throw new AggregateError(errors, 'One or more graceful shutdown stages failed');
}
