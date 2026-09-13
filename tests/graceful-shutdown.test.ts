import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createIdempotentShutdown,
  drainRuntime,
  GracefulShutdownTimeoutError,
  withGracefulShutdownDeadline,
} from '../src/operations/graceful-shutdown.js';

describe('graceful runtime shutdown', () => {
  it('coalesces repeated shutdown signals into one drain', async () => {
    let calls = 0;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const shutdown = createIdempotentShutdown(async () => {
      calls += 1;
      await wait;
    });
    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');
    assert.equal(first, second);
    assert.equal(calls, 1);
    release();
    await first;
  });

  it('closes HTTP intake first, drains event delivery and workers, then closes the pool', async () => {
    const calls: string[] = [];
    let releaseHttp!: () => void;
    const httpDrained = new Promise<void>((resolve) => { releaseHttp = resolve; });
    const draining = drainRuntime({
      closeHttpIntake() { calls.push('http-intake-closed'); return httpDrained; },
      async stopDomainRuntime() { calls.push('domain-runtime-drained'); },
      async stopWorkers() { calls.push('workers-drained'); },
      async stopSupervisor() { calls.push('supervisor-stopped'); },
      async closePool() { calls.push('pool-closed'); },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [
      'http-intake-closed',
      'domain-runtime-drained',
      'workers-drained',
      'supervisor-stopped',
    ]);
    releaseHttp();
    await draining;
    assert.equal(calls.at(-1), 'pool-closed');
  });

  it('enforces a hard deadline around a stuck drain', async () => {
    await assert.rejects(
      withGracefulShutdownDeadline(new Promise<void>(() => undefined), 20),
      (error: unknown) => error instanceof GracefulShutdownTimeoutError && error.timeoutMs === 20,
    );
  });
});
