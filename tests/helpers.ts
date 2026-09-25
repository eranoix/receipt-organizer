import { OperationQueue, type QueueOptions } from '@/lib/queue/engine';
import { MemoryQueueStore } from '@/lib/queue/memory-store';

/** A queue on the in-memory store with a clock the test controls. */
export function makeQueue(opts: QueueOptions = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } };
  const store = new MemoryQueueStore();
  const queue = new OperationQueue(store, { now: clock.now, backoffBaseMs: 1_000, jitter: (ms) => ms, attemptTimeoutMs: 5_000, ...opts });
  return { queue, store, clock };
}
