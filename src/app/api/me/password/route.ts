import { q, q1 } from '@/lib/db';
import { api, HttpError, readJson } from '@/lib/server/api';
import { hashPassword, verifyPassword } from '@/lib/server/auth';
import { logEvent } from '@/lib/server/events';

export const POST = api({ role: 'viewer', limit: ['password', 5, 60_000] }, async ({ req, user, traceId }) => {
  const b = await readJson<{ current?: string; next?: string }>(req);
  const row = await q1<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!row || !(await verifyPassword(String(b.current ?? ''), row.password_hash))) throw new HttpError(422, 'Current password is not right', { current: 'wrong' });
  const next = String(b.next ?? '');
  if (next.length < 10) throw new HttpError(422, 'Use at least 10 characters', { next: 'too short' });
  await q('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(next)]);
  await logEvent({ source: 'audit', action: 'auth.password_changed', message: `${user.name} changed their password`, actorId: user.id, traceId });
  return { ok: true };
});
