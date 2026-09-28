import os from 'node:os';
import { q, q1 } from '../db';
import type { OperationQueue } from '../queue/engine';
import { ensureOccurrences, matchAll } from './bills';
import { refreshInboxSuggestions } from './classify';
import { logEvent } from './events';
import { workerQueue } from './handlers';
import { hashBackfill, intakeScan } from './intake';
import { runJobs } from './jobs';
import { drainOcr } from './ocr';
import { settlePayments } from './payments';
import { enqueue } from './queue';
import { deltaSync, ensureSyncState, fullReconcile, LOCK_STALE_MS } from './sync';

export interface WorkerCtx {
  id: string;
  queue: OperationQueue;
  startedAt: Date;
  last: Record<string, number>;
  stats: Record<string, number>;
}

export function createWorker(opts: { backoffBaseMs?: number } = {}): WorkerCtx {
  return {
    id: `${os.hostname()}-${process.pid}`,
    queue: workerQueue(opts),
    startedAt: new Date(),
    last: {},
    stats: { ticks: 0, opsApplied: 0, receiptsRead: 0 },
  };
}

export async function selfHeal(ctx: WorkerCtx): Promise<Record<string, unknown>> {
  await ensureSyncState();
  const heal = await ctx.queue.selfHeal();
  const stuckOcr = await q(`UPDATE receipts SET ocr_state = 'queued' WHERE ocr_state = 'running' RETURNING file_id`);
  const lock = await q(`UPDATE sync_state SET lock_owner = NULL, lock_heartbeat_at = NULL
                         WHERE lock_owner IS NOT NULL AND lock_heartbeat_at < now() - make_interval(secs => $1) RETURNING name`, [LOCK_STALE_MS / 1000]);
  const summary = { reclaimedOperations: heal.reclaimed, breakersRebuilt: heal.breakers, receiptsRequeued: stuckOcr.length, staleLocksReleased: lock.length };
  await logEvent({
    source: 'system', action: 'worker.started',
    level: heal.reclaimed || stuckOcr.length || lock.length ? 'warn' : 'info',
    message: `Worker ${ctx.id} started. Self-heal: ${heal.reclaimed} operation(s) reclaimed, ${stuckOcr.length} reading(s) requeued, ${lock.length} stale lock(s) released`,
    data: summary,
  });
  return summary;
}

function due(ctx: WorkerCtx, key: string, everyMs: number): boolean {
  const now = Date.now();
  if ((ctx.last[key] ?? 0) + everyMs > now) return false;
  ctx.last[key] = now;
  return true;
}

export async function tick(ctx: WorkerCtx): Promise<void> {
  ctx.stats.ticks += 1;
  await q(`INSERT INTO worker_heartbeats (name, started_at, beat_at, info) VALUES ('worker', $1, now(), $2)
           ON CONFLICT (name) DO UPDATE SET started_at = EXCLUDED.started_at, beat_at = now(), info = EXCLUDED.info`,
    [ctx.startedAt, JSON.stringify({ id: ctx.id, ...ctx.stats })]);

  const st = await q1<{ full_requested_at: Date | null; last_full_at: Date | null; subscription_expires_at: Date | null }>(
    `SELECT full_requested_at, last_full_at, subscription_expires_at FROM sync_state WHERE name = 'drive'`);
  const fullDue = !!st?.full_requested_at || !st?.last_full_at || Date.now() - st.last_full_at.getTime() > 15 * 60_000;
  if (fullDue && due(ctx, 'full', 5_000)) await fullReconcile(ctx.id);
  else if (due(ctx, 'delta', 2_000)) await deltaSync(ctx.id);

  await intakeScan();
  await hashBackfill();
  const ocr = await drainOcr(5);
  ctx.stats.receiptsRead += ocr.read;

  const run = await ctx.queue.runOnce(20);
  ctx.stats.opsApplied += run.applied + run.noop;
  if (run.applied + run.noop > 0) await refreshInboxSuggestions();

  await runJobs();
  await settlePayments();

  if (due(ctx, 'converge', 30_000)) await ctx.queue.converge();
  if (due(ctx, 'bills', 60_000)) {
    await ensureOccurrences();
    await matchAll();
  }
  const exp = st?.subscription_expires_at?.getTime() ?? 0;
  if (exp - Date.now() < 12 * 3600_000 && due(ctx, 'subscribe', 60_000)) {
    await enqueue({ kind: 'drive.subscribe', idempotencyKey: `subscribe:${new Date().toISOString().slice(0, 13)}`, payload: { intent: 'subscribe' } });
  }
}

export async function runForever(ctx: WorkerCtx, intervalMs = 1_000, signal?: AbortSignal): Promise<void> {
  await selfHeal(ctx);
  while (!signal?.aborted) {
    const started = Date.now();
    try {
      await tick(ctx);
    } catch (err) {
      console.error('[worker] tick failed:', err);
    }
    await new Promise((r) => setTimeout(r, Math.max(100, intervalMs - (Date.now() - started))));
  }
}
