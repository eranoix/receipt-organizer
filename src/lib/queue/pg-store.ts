import { pool, type Db } from '../db';
import type { BreakerState } from './breaker';
import type { AttemptRecord, NewOperation, Operation, OperationPatch, OpStatus, QueueStore } from './types';

interface OpRow {
  id: number; kind: string; idempotency_key: string; payload: Record<string, unknown>; status: OpStatus;
  attempts: number; max_attempts: number; next_attempt_at: Date; deadline_at: Date | null; lease_expires_at: Date | null;
  last_error: string | null; last_error_code: string | null; dead_reason: Operation['deadReason'];
  outcome: Operation['outcome']; trace_id: string | null; subject_id: string | null; created_by: number | null;
  created_at: Date; updated_at: Date;
}

const ms = (d: Date | null) => (d ? d.getTime() : null);
const ts = (n: number | null | undefined) => (n == null ? null : new Date(n));

export function toOperation(r: OpRow): Operation {
  return {
    id: r.id, kind: r.kind, idempotencyKey: r.idempotency_key, payload: r.payload ?? {}, status: r.status,
    attempts: r.attempts, maxAttempts: r.max_attempts, nextAttemptAt: r.next_attempt_at.getTime(),
    deadlineAt: ms(r.deadline_at), leaseExpiresAt: ms(r.lease_expires_at), lastError: r.last_error,
    lastErrorCode: r.last_error_code, deadReason: r.dead_reason, outcome: r.outcome, traceId: r.trace_id,
    subjectId: r.subject_id, createdBy: r.created_by, createdAt: r.created_at.getTime(), updatedAt: r.updated_at.getTime(),
  };
}

const COLS: Record<string, string> = {
  status: 'status', attempts: 'attempts', nextAttemptAt: 'next_attempt_at', leaseExpiresAt: 'lease_expires_at',
  lastError: 'last_error', lastErrorCode: 'last_error_code', deadReason: 'dead_reason', outcome: 'outcome',
  payload: 'payload', deadlineAt: 'deadline_at', maxAttempts: 'max_attempts',
};
const TIME_COLS = new Set(['nextAttemptAt', 'leaseExpiresAt', 'deadlineAt']);

export class PgQueueStore implements QueueStore {
  constructor(private readonly db: Db = pool()) {}

  async insert(n: NewOperation, now: number, defaults: { maxAttempts: number }) {
    const ins = await this.db.query<OpRow>(
      `INSERT INTO operations (kind, idempotency_key, payload, status, max_attempts, next_attempt_at, deadline_at,
                               trace_id, subject_id, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $10)
       ON CONFLICT (kind, idempotency_key) DO NOTHING
       RETURNING *`,
      [n.kind, n.idempotencyKey, JSON.stringify(n.payload ?? {}), n.maxAttempts ?? defaults.maxAttempts,
        ts(now + (n.delayMs ?? 0)), n.deadlineMs != null ? ts(now + n.deadlineMs) : null,
        n.traceId ?? null, n.subjectId ?? null, n.createdBy ?? null, ts(now)],
    );
    if (ins.rows[0]) return { op: toOperation(ins.rows[0]), created: true };
    const existing = await this.db.query<OpRow>('SELECT * FROM operations WHERE kind = $1 AND idempotency_key = $2', [n.kind, n.idempotencyKey]);
    if (!existing.rows[0]) throw new Error('insert absorbed by the unique index but no row found');
    return { op: toOperation(existing.rows[0]), created: false };
  }

  async get(id: number) {
    const r = await this.db.query<OpRow>('SELECT * FROM operations WHERE id = $1', [id]);
    return r.rows[0] ? toOperation(r.rows[0]) : null;
  }

  async claimDue(now: number, limit: number, leaseMs: number, kinds: string[]) {
    const r = await this.db.query<OpRow>(
      `UPDATE operations o SET status = 'running', lease_expires_at = $2, updated_at = $1
        WHERE o.id IN (
          SELECT id FROM operations
           WHERE kind = ANY($4)
             AND ((status = 'pending' AND next_attempt_at <= $1)
               OR (status = 'running' AND lease_expires_at <= $1))
           ORDER BY next_attempt_at, id
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
        RETURNING o.*`,
      [ts(now), ts(now + leaseMs), limit, kinds],
    );
    return r.rows.map(toOperation).sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.id - b.id);
  }

  async update(id: number, patch: OperationPatch, now: number, expectStatus?: OpStatus) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'finished') continue;
      const col = COLS[k];
      if (!col) continue;
      vals.push(k === 'payload' ? JSON.stringify(v) : TIME_COLS.has(k) ? ts(v as number | null) : v);
      sets.push(`${col} = $${vals.length}`);
    }
    vals.push(ts(now));
    sets.push(`updated_at = $${vals.length}`);
    if (patch.finished) sets.push(`finished_at = $${vals.length}`);
    vals.push(id);
    let sql = `UPDATE operations SET ${sets.join(', ')} WHERE id = $${vals.length}`;
    if (expectStatus) {
      vals.push(expectStatus);
      sql += ` AND status = $${vals.length}`;
    }
    const r = await this.db.query(sql, vals);
    return (r.rowCount ?? 0) > 0;
  }

  async addAttempt(a: AttemptRecord) {
    await this.db.query(
      `INSERT INTO operation_attempts (operation_id, attempt_number, outcome, error, error_code, breaker, duration_ms, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [a.operationId, a.attemptNumber, a.outcome, a.error, a.errorCode, a.breaker, a.durationMs, ts(a.startedAt)],
    );
  }

  async overdue(now: number) {
    const r = await this.db.query<OpRow>(`SELECT * FROM operations WHERE status = 'pending' AND deadline_at <= $1`, [ts(now)]);
    return r.rows.map(toOperation);
  }

  async expiredLeases(now: number) {
    const r = await this.db.query<OpRow>(`SELECT * FROM operations WHERE status = 'running' AND lease_expires_at <= $1`, [ts(now)]);
    return r.rows.map(toOperation);
  }

  async unsettled(kinds: string[], limit: number) {
    const r = await this.db.query<OpRow>(
      `SELECT * FROM operations
        WHERE kind = ANY($1) AND (status = 'dead' OR (status = 'pending' AND attempts > 0))
        ORDER BY updated_at LIMIT $2`,
      [kinds, limit],
    );
    return r.rows.map(toOperation);
  }

  async loadBreaker(name: string) {
    const r = await this.db.query<{ state: BreakerState['mode']; consecutive_failures: number; opened_at: Date | null; trial_started_at: Date | null; version: number }>(
      'SELECT * FROM breakers WHERE name = $1', [name],
    );
    const b = r.rows[0];
    if (!b) return null;
    return { mode: b.state, consecutiveFailures: b.consecutive_failures, openedAt: ms(b.opened_at), trialStartedAt: ms(b.trial_started_at), version: b.version };
  }

  async saveBreaker(name: string, s: BreakerState, expectedVersion: number | null) {
    const vals = [name, s.mode, s.consecutiveFailures, ts(s.openedAt), ts(s.trialStartedAt), s.version];
    if (expectedVersion === null) {
      const r = await this.db.query(
        `INSERT INTO breakers (name, state, consecutive_failures, opened_at, trial_started_at, version)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (name) DO NOTHING`, vals,
      );
      return (r.rowCount ?? 0) > 0;
    }
    const r = await this.db.query(
      `UPDATE breakers SET state = $2, consecutive_failures = $3, opened_at = $4, trial_started_at = $5, version = $6, updated_at = now()
        WHERE name = $1 AND version = $7`, [...vals, expectedVersion],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async recentAttempts(breaker: string, limit: number) {
    const r = await this.db.query<{ operation_id: number; attempt_number: number; outcome: AttemptRecord['outcome']; error: string | null; error_code: string | null; breaker: string | null; duration_ms: number; started_at: Date }>(
      'SELECT * FROM operation_attempts WHERE breaker = $1 ORDER BY started_at DESC, id DESC LIMIT $2', [breaker, limit],
    );
    return r.rows.map((a) => ({
      operationId: a.operation_id, attemptNumber: a.attempt_number, outcome: a.outcome, error: a.error, errorCode: a.error_code,
      breaker: a.breaker, durationMs: a.duration_ms, startedAt: a.started_at.getTime(),
    }));
  }
}
