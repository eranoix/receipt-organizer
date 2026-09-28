import { q, q1 } from '@/lib/db';
import { api } from '@/lib/server/api';
import { logEvent } from '@/lib/server/events';

export const GET = api({}, async () => {
  const st = await q1(`SELECT last_delta_at, last_full_at, full_requested_at, lock_owner, lock_heartbeat_at, subscription_expires_at, last_error, last_error_at FROM sync_state WHERE name = 'drive'`);
  const pending = await q1<{ n: number }>(`SELECT count(*) AS n FROM operations WHERE status IN ('pending', 'running')`);
  return { state: st, pendingOperations: pending?.n ?? 0 };
});

export const POST = api({ role: 'member', limit: ['sync', 6, 60_000] }, async ({ user, traceId }) => {
  await q(`UPDATE sync_state SET full_requested_at = now() WHERE name = 'drive'`);
  await logEvent({ source: 'audit', action: 'sync.requested', actorId: user.id, traceId, message: `${user.name} asked for a full reconciliation with the drive` });
  return { requested: true };
});
