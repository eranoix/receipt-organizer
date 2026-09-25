import { NextResponse } from 'next/server';
import { q, q1 } from '@/lib/db';
import { api, HttpError, readJson } from '@/lib/server/api';

export const GET = api({}, async ({ user }) => {
  const u = await q1(`SELECT created_at, last_login_at FROM users WHERE id = $1`, [user.id]);
  const scopes = await q<{ path: string }>(`SELECT d.path FROM user_folder_scopes s JOIN drive_items d ON d.id = s.folder_id WHERE s.user_id = $1 ORDER BY d.path`, [user.id]);
  const sessions = await q(`SELECT created_at, expires_at, user_agent FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`, [user.id]);
  return { user, meta: u, scopes: user.role === 'admin' ? ['/ (everything)'] : scopes.map((s) => s.path), sessions };
});

export const PATCH = api({ role: 'viewer' }, async ({ req, user }) => {
  const b = await readJson<{ name?: string; statusText?: string; avatarColor?: string; theme?: string; notify?: { dlq?: boolean; duplicates?: boolean; bills?: boolean } }>(req);
  const name = b.name?.trim();
  if (name !== undefined && (name.length < 2 || name.length > 60)) throw new HttpError(422, 'Name must be 2 to 60 characters');
  if (b.statusText !== undefined && b.statusText.length > 120) throw new HttpError(422, 'Status must be under 120 characters');
  if (b.avatarColor !== undefined && !/^#[0-9a-f]{6}$/i.test(b.avatarColor)) throw new HttpError(422, 'Pick a color');
  if (b.theme !== undefined && !['system', 'light', 'dark'].includes(b.theme)) throw new HttpError(422, 'Unknown theme');
  await q(`UPDATE users SET name = COALESCE($2, name), status_text = COALESCE($3, status_text), avatar_color = COALESCE($4, avatar_color), theme = COALESCE($5, theme),
                  notify_dlq = COALESCE($6, notify_dlq), notify_duplicates = COALESCE($7, notify_duplicates), notify_bills = COALESCE($8, notify_bills) WHERE id = $1`,
    [user.id, name ?? null, b.statusText ?? null, b.avatarColor ?? null, b.theme ?? null, b.notify?.dlq ?? null, b.notify?.duplicates ?? null, b.notify?.bills ?? null]);
  const res = NextResponse.json({ ok: true });
  if (b.theme) res.cookies.set('ro_theme', b.theme, { path: '/', sameSite: 'lax', maxAge: 365 * 86_400 });
  return res;
});
