import { q } from '@/lib/db';
import { api, HttpError, readJson } from '@/lib/server/api';
import { hashPassword } from '@/lib/server/auth';
import { logEvent } from '@/lib/server/events';

export const GET = api({ role: 'admin' }, async () => {
  const users = await q(`SELECT u.id, u.email, u.name, u.role, u.avatar_color, u.disabled, u.last_login_at, u.created_at,
                                coalesce((SELECT json_agg(json_build_object('id', d.id, 'path', d.path) ORDER BY d.path) FROM user_folder_scopes s JOIN drive_items d ON d.id = s.folder_id WHERE s.user_id = u.id), '[]') AS scopes
                           FROM users u ORDER BY u.role, u.name`);
  return { users };
});

export const POST = api({ role: 'admin' }, async ({ req, user, traceId }) => {
  const b = await readJson<{ email?: string; name?: string; role?: string; password?: string }>(req);
  const email = String(b.email ?? '').trim().toLowerCase();
  const errors: Record<string, string> = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter an email';
  if (!b.name?.trim()) errors.name = 'Enter a name';
  if (!['admin', 'member', 'viewer'].includes(String(b.role))) errors.role = 'Pick a role';
  if (String(b.password ?? '').length < 10) errors.password = 'At least 10 characters';
  if (Object.keys(errors).length) throw new HttpError(422, 'Check the highlighted fields', errors);
  const rows = await q<{ id: number }>(`INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING RETURNING id`,
    [email, b.name!.trim(), b.role, await hashPassword(String(b.password))]);
  if (!rows[0]) throw new HttpError(409, 'That email already has an account', { email: 'taken' });
  await logEvent({ source: 'audit', action: 'user.created', actorId: user.id, traceId, message: `${user.name} added ${b.name} as ${b.role}` });
  return { id: rows[0].id };
});
