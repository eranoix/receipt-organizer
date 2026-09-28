import type { BreakerState } from './breaker';
import type { AttemptRecord, NewOperation, Operation, OperationPatch, OpStatus, QueueStore } from './types';

export class MemoryQueueStore implements QueueStore {
  readonly ops = new Map<number, Operation>();
  readonly attempts: AttemptRecord[] = [];
  readonly breakers = new Map<string, BreakerState>();
  private seq = 0;

  async insert(n: NewOperation, now: number, defaults: { maxAttempts: number }) {
    for (const op of this.ops.values()) {
      if (op.kind === n.kind && op.idempotencyKey === n.idempotencyKey) return { op: { ...op }, created: false };
    }
    this.seq += 1;
    const op: Operation = {
      id: this.seq, kind: n.kind, idempotencyKey: n.idempotencyKey, payload: n.payload ?? {}, status: 'pending',
      attempts: 0, maxAttempts: n.maxAttempts ?? defaults.maxAttempts, nextAttemptAt: now + (n.delayMs ?? 0),
      deadlineAt: n.deadlineMs != null ? now + n.deadlineMs : null, leaseExpiresAt: null, lastError: null,
      lastErrorCode: null, deadReason: null, outcome: null, traceId: n.traceId ?? null, subjectId: n.subjectId ?? null,
      createdBy: n.createdBy ?? null, createdAt: now, updatedAt: now,
    };
    this.ops.set(op.id, op);
    return { op: { ...op }, created: true };
  }

  async get(id: number) {
    const op = this.ops.get(id);
    return op ? { ...op } : null;
  }

  async claimDue(now: number, limit: number, leaseMs: number, kinds: string[]) {
    const due = [...this.ops.values()]
      .filter((o) => kinds.includes(o.kind))
      .filter((o) => (o.status === 'pending' && o.nextAttemptAt <= now) || (o.status === 'running' && o.leaseExpiresAt != null && o.leaseExpiresAt <= now))
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.id - b.id)
      .slice(0, limit);
    for (const o of due) {
      o.status = 'running';
      o.leaseExpiresAt = now + leaseMs;
      o.updatedAt = now;
    }
    return due.map((o) => ({ ...o }));
  }

  async update(id: number, patch: OperationPatch, now: number, expectStatus?: OpStatus) {
    const op = this.ops.get(id);
    if (!op) return false;
    if (expectStatus && op.status !== expectStatus) return false;
    const { finished: _f, ...rest } = patch;
    Object.assign(op, rest, { updatedAt: now });
    return true;
  }

  async addAttempt(a: AttemptRecord) {
    this.attempts.push({ ...a });
  }

  async overdue(now: number) {
    return [...this.ops.values()].filter((o) => o.status === 'pending' && o.deadlineAt != null && o.deadlineAt <= now).map((o) => ({ ...o }));
  }

  async expiredLeases(now: number) {
    return [...this.ops.values()].filter((o) => o.status === 'running' && o.leaseExpiresAt != null && o.leaseExpiresAt <= now).map((o) => ({ ...o }));
  }

  async unsettled(kinds: string[], limit: number) {
    return [...this.ops.values()]
      .filter((o) => kinds.includes(o.kind) && (o.status === 'dead' || (o.status === 'pending' && o.attempts > 0)))
      .slice(0, limit)
      .map((o) => ({ ...o }));
  }

  async loadBreaker(name: string) {
    const b = this.breakers.get(name);
    return b ? { ...b } : null;
  }

  async saveBreaker(name: string, next: BreakerState, expectedVersion: number | null) {
    const cur = this.breakers.get(name);
    if (expectedVersion === null ? cur !== undefined : cur?.version !== expectedVersion) return false;
    this.breakers.set(name, { ...next });
    return true;
  }

  async recentAttempts(breaker: string, limit: number) {
    return this.attempts.filter((a) => a.breaker === breaker).sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  attemptsOf(id: number) {
    return this.attempts.filter((a) => a.operationId === id);
  }
}
