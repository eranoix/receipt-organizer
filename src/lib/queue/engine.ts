/**
 * The operation queue.
 *
 * Every change to the drive (move, rename, create folder, delete, upload) is
 * submitted here instead of being called directly. The queue gives each one:
 *
 *   - an identity (kind + idempotency key), so a double click or a retried
 *     HTTP request produces one operation, not two;
 *   - retries with capped exponential backoff for transient failures, and an
 *     immediate stop for permanent ones;
 *   - a deadline budget: no attempt starts without enough time left, the
 *     attempt is cancelled through an AbortSignal when time runs out, and no
 *     retry is scheduled past the deadline;
 *   - a circuit breaker per provider with a single HALF_OPEN trial;
 *   - a dead-letter queue (status `dead`) with replay and discard;
 *   - a convergence loop that asks the provider whether the end state already
 *     holds, and settles operations whose effect happened anyway;
 *   - a startup self-heal that reclaims work from a worker that died.
 *
 * Ideas and vocabulary follow my reliable-task-queue library; this version
 * adds the breaker, the deadline budget and the pluggable store.
 */

import { admit, record, rebuild, initialBreaker, DEFAULT_BREAKER, type BreakerConfig, type BreakerState, type CallResult } from './breaker';
import { classifyError, type ErrorVerdict } from './errors';
import type { HandlerSpec, NewOperation, Operation, QueueStore } from './types';

export interface QueueHooks {
  onSucceeded?(op: Operation, detail: string | undefined): Promise<void> | void;
  onDead?(op: Operation): Promise<void> | void;
  onRetry?(op: Operation, verdict: ErrorVerdict): Promise<void> | void;
}

export interface QueueOptions {
  now?: () => number;
  leaseMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  maxAttempts?: number;
  /** Upper bound for one attempt, before the deadline is considered. */
  attemptTimeoutMs?: number;
  /** An attempt is not started with less time than this left before the deadline. */
  minBudgetMs?: number;
  /** Extra time a handler that ignores its AbortSignal gets before the worker moves on. */
  abandonGraceMs?: number;
  breaker?: BreakerConfig;
  /** Spreads retries so a recovering provider is not hit by everyone at once. */
  jitter?: (ms: number) => number;
  hooks?: QueueHooks;
  /** Deadline granted to a replayed operation whose original deadline passed. */
  replayDeadlineMs?: number;
}

export interface RunSummary {
  claimed: number;
  applied: number;
  noop: number;
  retried: number;
  dead: number;
  deferred: number;
  expired: number;
}

type ExecOutcome = 'applied' | 'noop' | 'retried' | 'dead' | 'deferred';

const emptySummary = (): RunSummary => ({ claimed: 0, applied: 0, noop: 0, retried: 0, dead: 0, deferred: 0, expired: 0 });

export class OperationQueue {
  private readonly specs = new Map<string, HandlerSpec>();
  private readonly now: () => number;
  private readonly o: Required<Omit<QueueOptions, 'now' | 'hooks'>>;
  private readonly hooks: QueueHooks;

  constructor(private readonly store: QueueStore, opts: QueueOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.hooks = opts.hooks ?? {};
    this.o = {
      leaseMs: opts.leaseMs ?? 60_000,
      backoffBaseMs: opts.backoffBaseMs ?? 2_000,
      backoffCapMs: opts.backoffCapMs ?? 5 * 60_000,
      maxAttempts: opts.maxAttempts ?? 6,
      attemptTimeoutMs: opts.attemptTimeoutMs ?? 30_000,
      minBudgetMs: opts.minBudgetMs ?? 1_000,
      abandonGraceMs: opts.abandonGraceMs ?? 5_000,
      breaker: opts.breaker ?? DEFAULT_BREAKER,
      jitter: opts.jitter ?? ((ms) => Math.round(ms * (0.8 + Math.random() * 0.4))),
      replayDeadlineMs: opts.replayDeadlineMs ?? 60 * 60_000,
    };
  }

  register(kind: string, spec: HandlerSpec): this {
    this.specs.set(kind, spec);
    return this;
  }

  kinds(): string[] {
    return [...this.specs.keys()];
  }

  /** Record an intent. Repeating a submit with the same identity returns the existing operation. */
  submit(op: NewOperation): Promise<{ op: Operation; created: boolean }> {
    return this.store.insert(op, this.now(), { maxAttempts: this.o.maxAttempts });
  }

  /** One bounded pass over everything that is due. */
  async runOnce(limit = 20): Promise<RunSummary> {
    const summary = emptySummary();

    // Abandon what is past its deadline before claiming: doing the work and
    // then finding out it was too late is the worst of both outcomes.
    for (const op of await this.store.overdue(this.now())) {
      if (await this.kill(op, 'deadline', op.lastError ?? 'deadline passed before the operation could run', op.lastErrorCode ?? 'deadline', 'pending')) {
        summary.expired += 1;
      }
    }

    const claimed = await this.store.claimDue(this.now(), limit, this.o.leaseMs, this.kinds());
    for (const op of claimed) {
      summary.claimed += 1;
      const out = await this.execute(op);
      summary[out] += 1;
    }
    return summary;
  }

  private async execute(op: Operation): Promise<ExecOutcome> {
    const spec = this.specs.get(op.kind);
    const attempt = op.attempts + 1;
    const startedAt = this.now();

    if (!spec) {
      await this.kill(op, 'permanent', `no handler registered for "${op.kind}"`, 'no_handler');
      return 'dead';
    }

    // Deadline budget: starting an attempt that cannot finish in time only
    // creates a half-done effect.
    const remaining = op.deadlineAt == null ? Infinity : op.deadlineAt - startedAt;
    if (remaining < this.o.minBudgetMs) {
      await this.kill(op, 'deadline', `deadline budget exhausted before attempt ${attempt}`, 'deadline');
      return 'dead';
    }

    let trial = false;
    if (spec.breaker) {
      const gate = await this.admitThroughBreaker(spec.breaker);
      if (!gate.allow) {
        // Not an attempt: the provider was never called. Push the operation
        // back without spending its budget.
        await this.store.update(op.id, { status: 'pending', leaseExpiresAt: null, nextAttemptAt: startedAt + gate.retryInMs }, this.now(), 'running');
        return 'deferred';
      }
      trial = gate.trial;
    }

    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.min(this.o.attemptTimeoutMs, remaining));
    const timer = setTimeout(() => controller.abort(new DOMException('attempt timed out', 'TimeoutError')), timeoutMs);
    let abandonTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      // The AbortSignal is the real cancellation: adapters pass it to fetch
      // and to their own waits, so a timed-out move does not land later. The
      // race below only guarantees the worker gets its slot back from a
      // handler that ignores the signal; the convergence loop settles the
      // rare effect that still lands afterwards.
      const abandoned = new Promise<never>((_, reject) => {
        abandonTimer = setTimeout(
          () => reject(new DOMException('handler ignored cancellation', 'TimeoutError')),
          timeoutMs + this.o.abandonGraceMs,
        );
      });
      const result = await Promise.race([spec.run(op.payload, { op, attempt, signal: controller.signal }), abandoned]);

      const outcome = (result as { outcome?: unknown } | null)?.outcome;
      if (outcome !== 'applied' && outcome !== 'noop') {
        throw Object.assign(new Error(`handler for "${op.kind}" returned an invalid outcome ${JSON.stringify(outcome)}`), { code: 'validationFailed' });
      }

      const now = this.now();
      await this.store.update(op.id, {
        status: 'succeeded', attempts: attempt, leaseExpiresAt: null, outcome, lastError: null, lastErrorCode: null, finished: true,
      }, now);
      await this.store.addAttempt({
        operationId: op.id, attemptNumber: attempt, outcome, error: result.detail ?? null, errorCode: null,
        breaker: spec.breaker ?? null, durationMs: now - startedAt, startedAt,
      });
      if (spec.breaker) await this.recordBreaker(spec.breaker, 'success', trial);
      await this.fire(() => this.hooks.onSucceeded?.({ ...op, status: 'succeeded', attempts: attempt, outcome }, result.detail));
      return outcome;
    } catch (err) {
      const verdict = classifyError(err);
      const now = this.now();
      await this.store.addAttempt({
        operationId: op.id, attemptNumber: attempt, outcome: verdict.permanent ? 'permanent' : 'retryable',
        error: verdict.message, errorCode: verdict.code, breaker: spec.breaker ?? null, durationMs: now - startedAt, startedAt,
      });
      if (spec.breaker) await this.recordBreaker(spec.breaker, verdict.permanent ? 'permanent' : 'transient', trial);

      const withAttempt = { ...op, attempts: attempt };
      if (verdict.permanent) {
        await this.kill(withAttempt, 'permanent', verdict.message, verdict.code);
        return 'dead';
      }
      if (attempt >= op.maxAttempts) {
        await this.kill(withAttempt, 'exhausted', verdict.message, verdict.code);
        return 'dead';
      }
      const wait = Math.max(this.backoff(attempt), verdict.retryAfterMs ?? 0);
      const next = now + wait;
      if (op.deadlineAt != null && next + this.o.minBudgetMs > op.deadlineAt) {
        // The retry could never run in time. Say so now rather than letting
        // the operation sit "pending" until the deadline sweeps it up.
        await this.kill(withAttempt, 'deadline', verdict.message, verdict.code);
        return 'dead';
      }
      await this.store.update(op.id, {
        status: 'pending', attempts: attempt, leaseExpiresAt: null, nextAttemptAt: next,
        lastError: verdict.message, lastErrorCode: verdict.code,
      }, now);
      await this.fire(() => this.hooks.onRetry?.(withAttempt, verdict));
      return 'retried';
    } finally {
      clearTimeout(timer);
      if (abandonTimer) clearTimeout(abandonTimer);
    }
  }

  /** Capped exponential backoff with jitter. */
  backoff(attempt: number): number {
    return this.o.jitter(Math.min(this.o.backoffBaseMs * 2 ** (attempt - 1), this.o.backoffCapMs));
  }

  // ── dead-letter queue ───────────────────────────────────────────────────

  /**
   * Put a dead operation back in line. `payloadPatch` lets a human fix what
   * made it fail permanently, e.g. choose a new name after a collision.
   */
  async replay(id: number, payloadPatch?: Record<string, unknown>): Promise<boolean> {
    const op = await this.store.get(id);
    if (!op || (op.status !== 'dead' && op.status !== 'discarded')) return false;
    const now = this.now();
    return this.store.update(id, {
      status: 'pending', attempts: 0, nextAttemptAt: now, leaseExpiresAt: null, deadReason: null,
      payload: payloadPatch ? { ...op.payload, ...payloadPatch } : op.payload,
      deadlineAt: op.deadlineAt != null && op.deadlineAt <= now + this.o.minBudgetMs ? now + this.o.replayDeadlineMs : op.deadlineAt,
    }, now, op.status);
  }

  async discard(id: number): Promise<boolean> {
    return this.store.update(id, { status: 'discarded', leaseExpiresAt: null, finished: true }, this.now(), 'dead');
  }

  // ── convergence and self-heal ───────────────────────────────────────────

  /**
   * Ask the provider whether the desired end state already holds for work we
   * think is unfinished, and settle it if so. This is what turns "the move
   * timed out but actually happened" into a success instead of a DLQ entry.
   */
  async converge(limit = 50): Promise<{ checked: number; settled: number }> {
    const kinds = [...this.specs.entries()].filter(([, s]) => s.probe).map(([k]) => k);
    if (kinds.length === 0) return { checked: 0, settled: 0 };
    let settled = 0;
    const ops = await this.store.unsettled(kinds, limit);
    for (const op of ops) {
      const spec = this.specs.get(op.kind);
      if (!spec?.probe) continue;
      let holds = false;
      try {
        holds = await spec.probe(op.payload, AbortSignal.timeout(this.o.attemptTimeoutMs));
      } catch {
        continue; // a probe that cannot answer settles nothing
      }
      if (!holds) continue;
      const now = this.now();
      const ok = await this.store.update(op.id, {
        status: 'succeeded', outcome: 'converged', leaseExpiresAt: null, lastError: null, lastErrorCode: null, deadReason: null, finished: true,
      }, now, op.status);
      if (!ok) continue;
      await this.store.addAttempt({
        operationId: op.id, attemptNumber: op.attempts + 1, outcome: 'noop', error: 'settled by convergence: end state already holds',
        errorCode: null, breaker: spec.breaker ?? null, durationMs: 0, startedAt: now,
      });
      settled += 1;
      await this.fire(() => this.hooks.onSucceeded?.({ ...op, status: 'succeeded', outcome: 'converged' }, 'converged'));
    }
    return { checked: ops.length, settled };
  }

  /**
   * Run once when a worker starts.
   *
   * A worker that died mid-attempt leaves rows `running` with a lease nobody
   * will renew, and possibly a breaker stuck HALF_OPEN waiting for a trial
   * that will never report back. Both are repaired here instead of waiting
   * for a human to notice that "nothing is moving".
   */
  async selfHeal(): Promise<{ reclaimed: number; breakers: string[] }> {
    const now = this.now();
    let reclaimed = 0;
    for (const op of await this.store.expiredLeases(now)) {
      const attempt = op.attempts + 1;
      await this.store.addAttempt({
        operationId: op.id, attemptNumber: attempt, outcome: 'retryable', error: 'worker stopped mid-attempt (lease expired)',
        errorCode: 'lease_expired', breaker: this.specs.get(op.kind)?.breaker ?? null, durationMs: 0, startedAt: now,
      });
      if (attempt >= op.maxAttempts) {
        await this.kill({ ...op, attempts: attempt }, 'exhausted', 'worker stopped mid-attempt (lease expired)', 'lease_expired', 'running');
      } else {
        await this.store.update(op.id, { status: 'pending', attempts: attempt, leaseExpiresAt: null, nextAttemptAt: now }, now, 'running');
      }
      reclaimed += 1;
    }

    const breakers = [...new Set([...this.specs.values()].map((s) => s.breaker).filter((b): b is string => !!b))];
    for (const name of breakers) {
      const current = await this.store.loadBreaker(name);
      const history = await this.store.recentAttempts(name, 50);
      const rebuilt = rebuild(
        history.map((h) => ({ outcome: h.outcome, startedAt: h.startedAt })),
        current?.version ?? 0,
        this.o.breaker,
      );
      await this.store.saveBreaker(name, rebuilt, current ? current.version : null);
    }
    return { reclaimed, breakers };
  }

  async breakerState(name: string): Promise<BreakerState> {
    return (await this.store.loadBreaker(name)) ?? initialBreaker();
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async kill(op: Operation, reason: 'permanent' | 'exhausted' | 'deadline', message: string, code: string, expect: 'running' | 'pending' = 'running'): Promise<boolean> {
    const ok = await this.store.update(op.id, {
      status: 'dead', attempts: op.attempts, deadReason: reason, leaseExpiresAt: null, lastError: message, lastErrorCode: code, finished: true,
    }, this.now(), expect);
    if (ok) await this.fire(() => this.hooks.onDead?.({ ...op, status: 'dead', deadReason: reason, lastError: message, lastErrorCode: code }));
    return ok;
  }

  private async admitThroughBreaker(name: string): Promise<{ allow: true; trial: boolean } | { allow: false; retryInMs: number }> {
    for (let i = 0; i < 3; i += 1) {
      const stored = await this.store.loadBreaker(name);
      const state = stored ?? initialBreaker();
      const a = admit(state, this.now(), this.o.breaker);
      if (!a.allow) return { allow: false, retryInMs: a.retryInMs };
      if (a.next === state) return { allow: true, trial: false };
      // A transition (OPEN -> HALF_OPEN, or a new trial) must win the CAS.
      // Losing means another worker took the trial, so this one waits.
      if (await this.store.saveBreaker(name, a.next, stored ? stored.version : null)) return { allow: true, trial: a.trial };
      return { allow: false, retryInMs: 1_000 };
    }
    return { allow: false, retryInMs: 1_000 };
  }

  private async recordBreaker(name: string, result: CallResult, _trial: boolean): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      const stored = await this.store.loadBreaker(name);
      const state = stored ?? initialBreaker();
      const next = record(state, result, this.now(), this.o.breaker);
      if (next === state) return;
      if (await this.store.saveBreaker(name, next, stored ? stored.version : null)) return;
    }
  }

  private async fire(fn: () => Promise<void> | void | undefined): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // A hook is bookkeeping around the operation, never the operation
      // itself: its failure must not flip a finished operation back.
      console.error('[queue] hook failed:', err);
    }
  }
}
