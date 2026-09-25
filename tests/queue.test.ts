import { describe, expect, it, vi } from 'vitest';
import { DriveError } from '@/lib/drive/types';
import { PermanentError, TransientError } from '@/lib/queue/errors';
import { makeQueue } from './helpers';

const ok = async () => ({ outcome: 'applied' as const });

describe('submit', () => {
  it('is idempotent on (kind, key)', async () => {
    const { queue, store } = makeQueue();
    const a = await queue.submit({ kind: 'drive.move', idempotencyKey: 'k1', payload: { n: 1 } });
    const b = await queue.submit({ kind: 'drive.move', idempotencyKey: 'k1', payload: { n: 2 } });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.op.id).toBe(a.op.id);
    expect(b.op.payload).toEqual({ n: 1 }); // the first intent wins
    expect(store.ops.size).toBe(1);
  });

  it('treats the same key under another kind as a different operation', async () => {
    const { queue } = makeQueue();
    const a = await queue.submit({ kind: 'drive.move', idempotencyKey: 'k1' });
    const b = await queue.submit({ kind: 'drive.delete', idempotencyKey: 'k1' });
    expect(b.created).toBe(true);
    expect(b.op.id).not.toBe(a.op.id);
  });
});

describe('execution', () => {
  it('runs a handler once and records an applied attempt', async () => {
    const { queue, store } = makeQueue();
    const run = vi.fn(ok);
    queue.register('x', { run });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1' });
    const s = await queue.runOnce();
    expect(s.applied).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await store.get(op.id))?.status).toBe('succeeded');
    expect(store.attemptsOf(op.id).map((a) => a.outcome)).toEqual(['applied']);
  });

  it('retries transient failures with capped exponential backoff, then succeeds', async () => {
    const { queue, store, clock } = makeQueue({ backoffBaseMs: 1_000, backoffCapMs: 3_000 });
    let calls = 0;
    queue.register('x', { run: async () => { calls += 1; if (calls < 4) throw new TransientError('503', 'serviceUnavailable'); return { outcome: 'applied' }; } });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1' });

    const waits: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      await queue.runOnce();
      const cur = (await store.get(op.id))!;
      if (cur.status === 'pending') {
        waits.push(cur.nextAttemptAt - clock.now());
        clock.advance(cur.nextAttemptAt - clock.now());
      }
    }
    expect(waits).toEqual([1_000, 2_000, 3_000]); // doubled, then capped
    expect((await store.get(op.id))?.status).toBe('succeeded');
    expect(store.attemptsOf(op.id).map((a) => a.outcome)).toEqual(['retryable', 'retryable', 'retryable', 'applied']);
  });

  it('respects a Retry-After longer than its own backoff', async () => {
    const { queue, store, clock } = makeQueue();
    queue.register('x', { run: async () => { throw Object.assign(new Error('slow down'), { status: 429, retryAfterMs: 30_000 }); } });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1' });
    await queue.runOnce();
    expect((await store.get(op.id))!.nextAttemptAt - clock.now()).toBe(30_000);
  });

  it('parks a name collision in the DLQ after ONE attempt: it is permanent', async () => {
    const { queue, store } = makeQueue();
    const run = vi.fn(async () => { throw new DriveError('nameAlreadyExists', '"a.pdf" already exists', 409); });
    queue.register('drive.move', { run });
    const { op } = await queue.submit({ kind: 'drive.move', idempotencyKey: '1' });
    await queue.runOnce();
    await queue.runOnce();
    const cur = (await store.get(op.id))!;
    expect(run).toHaveBeenCalledTimes(1);
    expect(cur.status).toBe('dead');
    expect(cur.deadReason).toBe('permanent');
    expect(cur.lastErrorCode).toBe('nameAlreadyExists');
  });

  it('classifies on the provider error code inside the body, not only the HTTP status', async () => {
    const { queue, store } = makeQueue();
    queue.register('x', { run: async () => { throw Object.assign(new Error('Conflict'), { status: 409, body: { error: { code: 'nameAlreadyExists' } } }); } });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1' });
    await queue.runOnce();
    expect((await store.get(op.id))?.deadReason).toBe('permanent');
  });

  it('moves an operation to the DLQ as exhausted after its attempt budget', async () => {
    const { queue, store, clock } = makeQueue();
    queue.register('x', { run: async () => { throw new Error('ECONNRESET'); } });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1', maxAttempts: 3 });
    for (let i = 0; i < 5; i += 1) { await queue.runOnce(); clock.advance(60_000); }
    const cur = (await store.get(op.id))!;
    expect(cur.status).toBe('dead');
    expect(cur.deadReason).toBe('exhausted');
    expect(cur.attempts).toBe(3);
  });

  it('rejects a handler result that is neither applied nor noop', async () => {
    const { queue, store } = makeQueue();
    queue.register('x', { run: async () => ({ outcome: 'aplied' }) as never });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1' });
    await queue.runOnce();
    expect((await store.get(op.id))?.status).toBe('dead');
  });

  it('fires onDead, and a failing hook does not undo the operation', async () => {
    const onDead = vi.fn(async () => { throw new Error('hook broke'); });
    const { queue, store } = makeQueue({ hooks: { onDead } });
    queue.register('x', { run: async () => { throw new PermanentError('no'); } });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await queue.runOnce();
    err.mockRestore();
    expect(onDead).toHaveBeenCalledTimes(1);
    expect((await store.get(op.id))?.status).toBe('dead');
  });
});

describe('deadline budget', () => {
  it('abandons an operation whose deadline passed without calling the handler', async () => {
    const { queue, store, clock } = makeQueue();
    const run = vi.fn(ok);
    queue.register('x', { run });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1', deadlineMs: 500 });
    clock.advance(1_000);
    const s = await queue.runOnce();
    expect(s.expired).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect((await store.get(op.id))?.deadReason).toBe('deadline');
  });

  it('does not schedule a retry that could only run after the deadline', async () => {
    const { queue, store } = makeQueue({ backoffBaseMs: 10_000 });
    queue.register('x', { run: async () => { throw new TransientError('blip'); } });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1', deadlineMs: 5_000 });
    await queue.runOnce();
    const cur = (await store.get(op.id))!;
    expect(cur.status).toBe('dead');
    expect(cur.deadReason).toBe('deadline');
    expect(cur.attempts).toBe(1);
  });

  it('cancels the attempt through the AbortSignal, so the effect never lands late', async () => {
    const { queue, store } = makeQueue({ attemptTimeoutMs: 40 });
    let applied = false;
    queue.register('x', {
      run: (_p, { signal }) => new Promise((resolve, reject) => {
        const t = setTimeout(() => { applied = true; resolve({ outcome: 'applied' }); }, 200);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); });
      }),
    });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1' });
    await queue.runOnce();
    await new Promise((r) => setTimeout(r, 250));
    expect(applied).toBe(false);
    const cur = (await store.get(op.id))!;
    expect(cur.status).toBe('pending');
    expect(cur.lastErrorCode).toBe('timeout');
  });

  it('gives the worker its slot back even if a handler ignores the signal', async () => {
    const { queue, store } = makeQueue({ attemptTimeoutMs: 20, abandonGraceMs: 20 });
    queue.register('x', { run: () => new Promise(() => undefined) });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1' });
    await queue.runOnce();
    expect((await store.get(op.id))?.lastErrorCode).toBe('timeout');
  });
});

describe('dead-letter queue', () => {
  it('replays with a payload patch (e.g. a new name after a collision)', async () => {
    const { queue, store } = makeQueue();
    const seen: unknown[] = [];
    queue.register('drive.move', {
      run: async (p) => {
        seen.push(p.name);
        if (p.name === 'a.pdf') throw new DriveError('nameAlreadyExists', 'exists', 409);
        return { outcome: 'applied' };
      },
    });
    const { op } = await queue.submit({ kind: 'drive.move', idempotencyKey: '1', payload: { name: 'a.pdf' } });
    await queue.runOnce();
    expect(await queue.replay(op.id, { name: 'a (2).pdf' })).toBe(true);
    const replayed = (await store.get(op.id))!;
    expect(replayed.status).toBe('pending');
    expect(replayed.attempts).toBe(0);
    await queue.runOnce();
    expect((await store.get(op.id))?.status).toBe('succeeded');
    expect(seen).toEqual(['a.pdf', 'a (2).pdf']);
  });

  it('discards only dead operations, and a discarded one can still be replayed', async () => {
    const { queue, store } = makeQueue();
    queue.register('x', { run: async () => { throw new PermanentError('no'); } });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1' });
    expect(await queue.discard(op.id)).toBe(false); // still pending
    await queue.runOnce();
    expect(await queue.discard(op.id)).toBe(true);
    expect((await store.get(op.id))?.status).toBe('discarded');
    expect(await queue.replay(op.id)).toBe(true);
  });

  it('gives a replayed operation a fresh deadline when the old one has passed', async () => {
    const { queue, store, clock } = makeQueue({ replayDeadlineMs: 60_000 });
    queue.register('x', { run: ok });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1', deadlineMs: 100 });
    clock.advance(1_000);
    await queue.runOnce();
    await queue.replay(op.id);
    expect((await store.get(op.id))!.deadlineAt).toBe(clock.now() + 60_000);
  });
});

describe('convergence and self-heal', () => {
  it('settles a dead operation whose end state already holds', async () => {
    const { queue, store } = makeQueue();
    let landed = false;
    queue.register('x', {
      run: async () => { landed = true; throw new PermanentError('connection dropped after the provider applied it'); },
      probe: async () => landed,
    });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1' });
    await queue.runOnce();
    expect((await store.get(op.id))?.status).toBe('dead');
    const r = await queue.converge();
    expect(r.settled).toBe(1);
    const cur = (await store.get(op.id))!;
    expect(cur.status).toBe('succeeded');
    expect(cur.outcome).toBe('converged');
  });

  it('leaves operations alone when the probe says the work is not done', async () => {
    const { queue, store } = makeQueue();
    queue.register('x', { run: async () => { throw new PermanentError('no'); }, probe: async () => false });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1' });
    await queue.runOnce();
    expect((await queue.converge()).settled).toBe(0);
    expect((await store.get(op.id))?.status).toBe('dead');
  });

  it('reclaims work leased by a worker that died', async () => {
    const { queue, store, clock } = makeQueue({ leaseMs: 1_000 });
    queue.register('x', { run: ok });
    const { op } = await queue.submit({ kind: 'x', idempotencyKey: '1' });
    await store.claimDue(clock.now(), 10, 1_000, ['x']); // a worker took it, then vanished
    clock.advance(5_000);
    const heal = await queue.selfHeal();
    expect(heal.reclaimed).toBe(1);
    const cur = (await store.get(op.id))!;
    expect(cur.status).toBe('pending');
    expect(store.attemptsOf(op.id)[0].errorCode).toBe('lease_expired');
    await queue.runOnce();
    expect((await store.get(op.id))?.status).toBe('succeeded');
  });

  it('repairs a breaker stuck HALF_OPEN by a trial that died with its worker', async () => {
    const { queue, store, clock } = makeQueue();
    queue.register('x', { run: ok, breaker: 'drive' });
    await store.saveBreaker('drive', { mode: 'half_open', consecutiveFailures: 5, openedAt: clock.now() - 60_000, trialStartedAt: clock.now() - 1_000, version: 3 }, null);
    await queue.selfHeal();
    expect((await queue.breakerState('drive')).mode).toBe('closed');
  });
});

describe('circuit breaker in the queue', () => {
  const failing = async () => { throw new TransientError('503', 'serviceUnavailable'); };

  it('opens after consecutive transient failures and stops calling the provider', async () => {
    const { queue, store } = makeQueue({ breaker: { failureThreshold: 3, cooldownMs: 30_000, trialTimeoutMs: 60_000 } });
    const run = vi.fn(failing);
    queue.register('x', { run, breaker: 'drive' });
    for (let i = 0; i < 3; i += 1) await queue.submit({ kind: 'x', idempotencyKey: `f${i}` });
    await queue.runOnce();
    expect((await queue.breakerState('drive')).mode).toBe('open');

    const { op } = await queue.submit({ kind: 'x', idempotencyKey: 'next' });
    const s = await queue.runOnce();
    expect(s.deferred).toBeGreaterThan(0);
    expect(run).toHaveBeenCalledTimes(3);
    expect((await store.get(op.id))!.attempts).toBe(0); // deferral does not spend the budget
  });

  it('lets exactly one trial through after the cooldown, and closes on success', async () => {
    const cfg = { failureThreshold: 2, cooldownMs: 10_000, trialTimeoutMs: 60_000 };
    const { queue, clock } = makeQueue({ breaker: cfg });
    let healthy = false;
    const run = vi.fn(async () => { if (!healthy) throw new TransientError('down'); return { outcome: 'applied' as const }; });
    queue.register('x', { run, breaker: 'drive' });
    await queue.submit({ kind: 'x', idempotencyKey: 'a' });
    await queue.submit({ kind: 'x', idempotencyKey: 'b' });
    await queue.runOnce();
    expect((await queue.breakerState('drive')).mode).toBe('open');

    healthy = true;
    clock.advance(cfg.cooldownMs + 60_000);
    run.mockClear();
    const s = await queue.runOnce();
    // First claimed op is the trial; it succeeds and closes the breaker, so
    // the second one in the same pass goes through normally.
    expect((await queue.breakerState('drive')).mode).toBe('closed');
    expect(s.applied).toBe(2);
  });

  it('does not count permanent errors toward opening the breaker', async () => {
    const { queue } = makeQueue({ breaker: { failureThreshold: 2, cooldownMs: 10_000, trialTimeoutMs: 60_000 } });
    queue.register('x', { run: async () => { throw new DriveError('nameAlreadyExists', 'exists', 409); }, breaker: 'drive' });
    for (let i = 0; i < 5; i += 1) await queue.submit({ kind: 'x', idempotencyKey: `c${i}` });
    await queue.runOnce();
    const b = await queue.breakerState('drive');
    expect(b.mode).toBe('closed');
    expect(b.consecutiveFailures).toBe(0);
  });
});
