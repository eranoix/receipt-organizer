import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { q, q1, type Db } from '../db';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;

export type Role = 'admin' | 'member' | 'viewer';
export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2 };
export const SESSION_COOKIE = 'ro_session';
export const SESSION_DAYS = 14;

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  avatarColor: string;
  statusText: string;
  theme: 'system' | 'light' | 'dark';
  notify: { dlq: boolean; duplicates: boolean; bills: boolean };
  /** Folder paths this user may see. ['/'] for admins. */
  scopePaths: string[];
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const N = 16384;
  const hash = await scrypt(pw, salt, 32, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [algo, n, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: 8, p: 1 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

export async function createSession(userId: number, userAgent: string | null): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await q(`INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
    [tokenHash(token), userId, SESSION_DAYS, userAgent?.slice(0, 200) ?? null]);
  await q('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  await q('DELETE FROM sessions WHERE expires_at < now()');
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await q('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
}

interface UserRow {
  id: number; email: string; name: string; role: Role; avatar_color: string; status_text: string; theme: SessionUser['theme'];
  notify_dlq: boolean; notify_duplicates: boolean; notify_bills: boolean;
}

export async function loadUser(id: number, db?: Db): Promise<SessionUser | null> {
  const u = await q1<UserRow>('SELECT * FROM users WHERE id = $1 AND NOT disabled', [id], db);
  return u ? toSessionUser(u, db) : null;
}

async function toSessionUser(u: UserRow, db?: Db): Promise<SessionUser> {
  let scopePaths = ['/'];
  if (u.role !== 'admin') {
    const rows = await q<{ path: string }>(
      `SELECT d.path FROM user_folder_scopes s JOIN drive_items d ON d.id = s.folder_id AND d.deleted_at IS NULL WHERE s.user_id = $1`, [u.id], db);
    scopePaths = rows.map((r) => r.path);
  }
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, avatarColor: u.avatar_color, statusText: u.status_text, theme: u.theme,
    notify: { dlq: u.notify_dlq, duplicates: u.notify_duplicates, bills: u.notify_bills }, scopePaths,
  };
}

export async function userFromToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const u = await q1<UserRow>(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`, [tokenHash(token)]);
  return u ? toSessionUser(u) : null;
}

export async function currentUser(): Promise<SessionUser | null> {
  const { cookies } = await import('next/headers');
  const jar = await cookies();
  return userFromToken(jar.get(SESSION_COOKIE)?.value);
}

export function hasRole(user: SessionUser, min: Role): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[min];
}
