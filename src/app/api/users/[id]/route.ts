import { q, tx } from '@/lib/db';
import { api, HttpError, readJson } from '@/lib/server/api';
import { logEvent } from '@/lib/server/events';

export const PATCH = api<{ id: string }>({ role: 'admin' }, async ({ req, user, params, traceId }) => {
  const id = Number(params.id);
  const b = await readJson<{ role?: string; disabled?: boolean; scopeFolderIds?: string[] }>(req);
  if (id === user.id && (b.role && b.role !== 'admin' || b.disabled)) throw new HttpError(409, 'You cannot demote or disable yourself');
  if (b.role && !['admin', 'member', 'viewer'].includes(b.role)) throw new HttpError(422, 'Unknown role');
  await tx(async (c) => {
    await c.query('UPDATE users SET role = COALESCE($2, role), disabled = COALESCE($3, disabled) WHERE id = $1', [id, b.role ?? null, b.disabled ?? null]);
    if (b.disabled) await c.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    if (Array.isArray(b.scopeFolderIds)) {
      await c.query('DELETE FROM user_folder_scopes WHERE user_id = $1', [id]);
      await c.query('INSERT INTO user_folder_scopes (user_id, folder_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [id, b.scopeFolderIds.slice(0, 100)]);
    }
  });
  const [u] = await q<{ name: string }>('SELECT name FROM users WHERE id = $1', [id]);
  await logEvent({ source: 'audit', action: 'user.updated', actorId: user.id, traceId, message: `${user.name} updated access for ${u?.name ?? `user ${id}`}`, data: b });
  return { ok: true };
});
