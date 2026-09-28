import { OperationQueue } from '../queue/engine';
import { PgQueueStore } from '../queue/pg-store';

export function workerlessQueue(): OperationQueue {
  return new OperationQueue(new PgQueueStore());
}
