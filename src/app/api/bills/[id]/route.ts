import { q } from '@/lib/db';
import { api, readJson } from '@/lib/server/api';
import { logEvent } from '@/lib/server/events';

export const PATCH = api<{ id: string }>({}, async ({ req, user, params, traceId }) => {
  const b = await readJson<{ active?: boolean }>(req);
  const rows = await q<{ name: string }>('UPDATE bills SET active = COALESCE($2, active) WHERE id = $1 RETURNING name', [Number(params.id), b.active ?? null]);
  if (rows[0]) await logEvent({ source: 'audit', action: 'bill.updated', actorId: user.id, traceId, message: `${user.name} ${b.active ? 'resumed' : 'paused'} "${rows[0].name}"` });
  return { ok: true };
});
