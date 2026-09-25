import { q } from '@/lib/db';
import { api, readJson } from '@/lib/server/api';

export const GET = api({}, async ({ user }) => {
  const rows = await q(`SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`, [user.id]);
  const unread = rows.filter((r) => !r.read_at).length;
  return { rows, unread };
});

export const POST = api({ role: 'viewer' }, async ({ req, user }) => {
  const b = await readJson<{ ids?: number[]; all?: boolean }>(req);
  if (b.all) await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]);
  else if (b.ids?.length) await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2)', [user.id, b.ids.map(Number)]);
  return { ok: true };
});
