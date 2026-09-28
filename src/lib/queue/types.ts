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
  deadlineMs?: number;
  traceId?: string | null;
  subjectId?: string | null;
  createdBy?: number | null;
  delayMs?: number;
}

export type OperationPatch = Partial<Pick<Operation,
  'status' | 'attempts' | 'nextAttemptAt' | 'leaseExpiresAt' | 'lastError' | 'lastErrorCode' |
  'deadReason' | 'outcome' | 'payload' | 'deadlineAt' | 'maxAttempts'>> & { finished?: boolean };

export interface QueueStore {
  insert(op: NewOperation, now: number, defaults: { maxAttempts: number }): Promise<{ op: Operation; created: boolean }>;
  get(id: number): Promise<Operation | null>;
  claimDue(now: number, limit: number, leaseMs: number, kinds: string[]): Promise<Operation[]>;
  update(id: number, patch: OperationPatch, now: number, expectStatus?: OpStatus): Promise<boolean>;
  addAttempt(a: AttemptRecord): Promise<void>;
  overdue(now: number): Promise<Operation[]>;
  expiredLeases(now: number): Promise<Operation[]>;
  unsettled(kinds: string[], limit: number): Promise<Operation[]>;
  loadBreaker(name: string): Promise<BreakerState | null>;
  saveBreaker(name: string, next: BreakerState, expectedVersion: number | null): Promise<boolean>;
  recentAttempts(breaker: string, limit: number): Promise<AttemptRecord[]>;
}

export type HandlerResult = { outcome: 'applied' | 'noop'; detail?: string };

export interface HandlerContext {
  op: Operation;
  attempt: number;
  signal: AbortSignal;
}

export interface HandlerSpec {
  run(payload: Record<string, unknown>, ctx: HandlerContext): Promise<HandlerResult>;
  breaker?: string;
  probe?(payload: Record<string, unknown>, signal: AbortSignal): Promise<boolean>;
}
