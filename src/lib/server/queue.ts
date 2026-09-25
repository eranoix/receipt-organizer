import { OperationQueue, type QueueHooks } from '../queue/engine';
import { PgQueueStore } from '../queue/pg-store';
import type { NewOperation } from '../queue/types';
import type { Db } from '../db';

/** Drive changes get half an hour to land; past that a human should know. */
export const DRIVE_DEADLINE_MS = 30 * 60_000;

/** Submit an operation. Safe to repeat with the same idempotency key. */
export async function enqueue(op: NewOperation, db?: Db) {
  return new PgQueueStore(db).insert(
    { deadlineMs: op.kind.startsWith('drive.') ? DRIVE_DEADLINE_MS : 10 * 60_000, ...op },
    Date.now(),
    { maxAttempts: 6 },
  );
}

export function queueFor(hooks: QueueHooks, opts: { backoffBaseMs?: number } = {}): OperationQueue {
  return new OperationQueue(new PgQueueStore(), {
    hooks,
    backoffBaseMs: opts.backoffBaseMs ?? Number(process.env.QUEUE_BACKOFF_MS ?? 2_000),
    attemptTimeoutMs: 20_000,
  });
}
