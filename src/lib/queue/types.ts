import type { BreakerState } from './breaker';

export type OpStatus = 'pending' | 'running' | 'succeeded' | 'dead' | 'discarded';
export type DeadReason = 'permanent' | 'exhausted' | 'deadline';
export type AttemptOutcome = 'applied' | 'noop' | 'retryable' | 'permanent';

export interface Operation {
  id: number;
  kind: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: OpStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  deadlineAt: number | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  lastErrorCode: string | null;
  deadReason: DeadReason | null;
  outcome: 'applied' | 'noop' | 'converged' | null;
  traceId: string | null;
  subjectId: string | null;
  createdBy: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AttemptRecord {
  operationId: number;
  attemptNumber: number;
  outcome: AttemptOutcome;
  error: string | null;
  errorCode: string | null;
  breaker: string | null;
  durationMs: number;
  startedAt: number;
}

export interface NewOperation {
  kind: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  /** Milliseconds from now after which the operation is abandoned. */
  deadlineMs?: number;
  traceId?: string | null;
  subjectId?: string | null;
  createdBy?: number | null;
  delayMs?: number;
}

export type OperationPatch = Partial<Pick<Operation,
  'status' | 'attempts' | 'nextAttemptAt' | 'leaseExpiresAt' | 'lastError' | 'lastErrorCode' |
  'deadReason' | 'outcome' | 'payload' | 'deadlineAt' | 'maxAttempts'>> & { finished?: boolean };

/**
 * Persistence behind the queue. Two implementations: Postgres for the app and
 * an in-memory one that lets the engine be tested without a database.
 */
export interface QueueStore {
  insert(op: NewOperation, now: number, defaults: { maxAttempts: number }): Promise<{ op: Operation; created: boolean }>;
  get(id: number): Promise<Operation | null>;
  /** Atomically lease due operations: pending and due, or running with an expired lease. */
  claimDue(now: number, limit: number, leaseMs: number, kinds: string[]): Promise<Operation[]>;
  /** Update fields. With `expectStatus`, only if the row is still in that status. Returns false if not. */
  update(id: number, patch: OperationPatch, now: number, expectStatus?: OpStatus): Promise<boolean>;
  addAttempt(a: AttemptRecord): Promise<void>;
  /** Pending operations whose deadline has passed. */
  overdue(now: number): Promise<Operation[]>;
  /** Running operations whose lease expired: their worker died mid-attempt. */
  expiredLeases(now: number): Promise<Operation[]>;
  /** Candidates for convergence: dead, or pending after at least one failure. */
  unsettled(kinds: string[], limit: number): Promise<Operation[]>;
  loadBreaker(name: string): Promise<BreakerState | null>;
  /** Compare-and-set on version. False means someone else transitioned first. */
  saveBreaker(name: string, next: BreakerState, expectedVersion: number | null): Promise<boolean>;
  recentAttempts(breaker: string, limit: number): Promise<AttemptRecord[]>;
}

export type HandlerResult = { outcome: 'applied' | 'noop'; detail?: string };

export interface HandlerContext {
  op: Operation;
  attempt: number;
  /** Aborts at the per-attempt timeout or the deadline, whichever is first. */
  signal: AbortSignal;
}

export interface HandlerSpec {
  run(payload: Record<string, unknown>, ctx: HandlerContext): Promise<HandlerResult>;
  /** Breaker this kind shares with others that hit the same provider. */
  breaker?: string;
  /**
   * "Is the desired end state already true?" Used by the convergence loop to
   * settle operations whose effect happened even though our record says not.
   */
  probe?(payload: Record<string, unknown>, signal: AbortSignal): Promise<boolean>;
}
