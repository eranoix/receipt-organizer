import { OperationQueue } from '../queue/engine';
import { PgQueueStore } from '../queue/pg-store';

/**
 * The web app replays and discards dead operations but never executes them;
 * execution belongs to the worker. This queue has no handlers on purpose.
 */
export function workerlessQueue(): OperationQueue {
  return new OperationQueue(new PgQueueStore());
}
