import { q1 } from '../db';
import { verdict, type Check } from '../ops/verdict';
import { LOCK_STALE_MS } from './sync';

const ago = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
};

export async function systemStatus(isAdmin: boolean) {
  const checks: Check[] = [];
  const t0 = Date.now();
  await q1('SELECT 1');
  const dbMs = Date.now() - t0;
  checks.push({ id: 'db', label: 'Database', status: dbMs > 500 ? 'warn' : 'ok', detail: `answered in ${dbMs} ms` });

  const hb = await q1<{ beat_at: Date; started_at: Date; info: Record<string, unknown> }>(`SELECT * FROM worker_heartbeats ORDER BY beat_at DESC LIMIT 1`);
  const hbAge = hb ? Date.now() - hb.beat_at.getTime() : Infinity;
  checks.push({
    id: 'worker', label: 'Background worker',
    status: hbAge > 120_000 ? 'fail' : hbAge > 30_000 ? 'warn' : 'ok',
    detail: hb ? `last heartbeat ${ago(hbAge)}, running since ${hb.started_at.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'has never reported in; nothing is being synced or read',
  });

  const st = await q1<{ last_delta_at: Date | null; last_full_at: Date | null; lock_owner: string | null; lock_heartbeat_at: Date | null; subscription_expires_at: Date | null; last_error: string | null; last_error_at: Date | null }>(
    `SELECT * FROM sync_state WHERE name = 'drive'`);
  const deltaAge = st?.last_delta_at ? Date.now() - st.last_delta_at.getTime() : Infinity;
  const recentError = st?.last_error && st.last_error_at && (!st.last_delta_at || st.last_error_at > st.last_delta_at);
  checks.push({
    id: 'sync', label: `Drive sync (${process.env.DRIVE_ADAPTER === 'graph' ? 'Microsoft Graph' : 'local drive'})`,
    status: recentError ? 'warn' : deltaAge > 10 * 60_000 ? 'warn' : 'ok',
    detail: recentError ? `last attempt failed: ${st!.last_error}` : st?.last_delta_at ? `last delta ${ago(deltaAge)}, last full reconciliation ${st.last_full_at ? ago(Date.now() - st.last_full_at.getTime()) : 'never'}` : 'has not run yet',
    action: isAdmin ? { label: 'Reconcile now', post: '/api/sync' } : undefined,
  });

  if (st?.lock_owner && st.lock_heartbeat_at) {
    const age = Date.now() - st.lock_heartbeat_at.getTime();
    checks.push({
      id: 'lock', label: 'Sync lock', status: age > LOCK_STALE_MS ? 'warn' : 'ok',
      detail: age > LOCK_STALE_MS ? `held by ${st.lock_owner} with no heartbeat for ${ago(age)}; it will be reclaimed automatically` : `held by ${st.lock_owner} (normal while syncing)`,
    });
  }

  const exp = st?.subscription_expires_at?.getTime() ?? 0;
  const left = exp - Date.now();
  checks.push({
    id: 'subscription', label: 'Change notifications',
    status: left <= 0 ? 'fail' : left < 24 * 3600_000 ? 'warn' : 'ok',
    detail: left <= 0 ? 'subscription expired; changes are only picked up by polling' : `subscription valid until ${new Date(exp).toISOString().slice(0, 16).replace('T', ' ')} UTC (renews itself 12 h before)`,
    action: isAdmin ? { label: 'Renew now', post: '/api/status/renew' } : undefined,
  });

  for (const [name, label, failLevel] of [['drive', 'Drive circuit breaker', 'fail'], ['payments', 'Payments circuit breaker', 'warn']] as const) {
    const b = await q1<{ state: string; consecutive_failures: number; opened_at: Date | null }>('SELECT * FROM breakers WHERE name = $1', [name]);
    const state = b?.state ?? 'closed';
    checks.push({
      id: `breaker-${name}`, label,
      status: state === 'open' ? failLevel : state === 'half_open' ? 'warn' : 'ok',
      detail: state === 'open' ? `open after ${b!.consecutive_failures} failures in a row; calls paused, a single trial runs after the cooldown`
        : state === 'half_open' ? 'testing the provider with one trial call' : 'closed (calls flowing normally)',
    });
  }

  const dead = await q1<{ n: number }>(`SELECT count(*) AS n FROM operations WHERE status = 'dead'`);
  checks.push({
    id: 'dlq', label: 'Dead-letter queue', status: dead!.n > 0 ? 'warn' : 'ok',
    detail: dead!.n > 0 ? `${dead!.n} operation(s) failed for good and need a decision (replay or discard)` : 'empty',
    action: dead!.n > 0 ? { label: 'Open', href: '/operations?state=open&source=queue' } : undefined,
  });

  const backlog = await q1<{ n: number; oldest: Date | null }>(`SELECT count(*) AS n, min(created_at) AS oldest FROM operations WHERE status IN ('pending', 'running')`);
  const oldest = backlog?.oldest ? Date.now() - backlog.oldest.getTime() : 0;
  checks.push({
    id: 'queue', label: 'Operation queue', status: oldest > 10 * 60_000 ? 'warn' : 'ok',
    detail: backlog!.n ? `${backlog!.n} in flight, oldest ${ago(oldest)}` : 'nothing waiting',
  });

  const ocr = await q1<{ queued: number; failed: number; limited: number }>(
    `SELECT count(*) FILTER (WHERE ocr_state IN ('queued', 'running')) AS queued, count(*) FILTER (WHERE ocr_state = 'failed') AS failed,
            (SELECT count(*) FROM extraction_runs WHERE status = 'rate_limited' AND created_at > now() - interval '10 minutes') AS limited
       FROM receipts`);
  checks.push({
    id: 'ocr', label: 'Receipt reading',
    status: ocr!.failed > 0 || ocr!.limited > 0 ? 'warn' : 'ok',
    detail: [
      ocr!.queued ? `${ocr!.queued} waiting to be read` : 'nothing waiting',
      ocr!.failed ? `${ocr!.failed} could not be read` : null,
      ocr!.limited ? `provider asked us to slow down ${ocr!.limited} time(s) in the last 10 min` : null,
    ].filter(Boolean).join('; '),
    action: ocr!.failed ? { label: 'Review', href: '/operations?state=open&source=ocr' } : undefined,
  });

  checks.push({ id: 'extractor', label: 'Extractor', status: 'ok', detail: process.env.EXTRACTOR === 'http' ? `HTTP provider at ${new URL(process.env.EXTRACTOR_URL ?? 'https://unset.example.com').host}` : 'deterministic mock (reads the document text layer)' });
  checks.push({ id: 'payments', label: 'Payment provider', status: 'ok', detail: 'mock provider (settles in a few seconds and returns a receipt)' });

  return { ...verdict(checks), checks, checkedAt: new Date().toISOString() };
}
