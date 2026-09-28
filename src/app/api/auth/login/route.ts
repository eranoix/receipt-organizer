import { NextResponse, type NextRequest } from 'next/server';
import { q1 } from '@/lib/db';
import { limiter } from '@/lib/rate-limit';
import { tooMany } from '@/lib/server/api';
import { createSession, SESSION_COOKIE, SESSION_DAYS, verifyPassword } from '@/lib/server/auth';
import { logEvent } from '@/lib/server/events';

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  const rl = limiter('login', 10, 60_000).hit(ip);
  if (!rl.ok) return tooMany(rl.retryAfterMs);

  let body: { email?: string; password?: string } = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const email = String(body.email ?? '').trim().toLowerCase();
  const user = await q1<{ id: number; name: string; password_hash: string; disabled: boolean }>('SELECT id, name, password_hash, disabled FROM users WHERE email = $1', [email]);
  const ok = user && !user.disabled ? await verifyPassword(String(body.password ?? ''), user.password_hash) : (await verifyPassword('x', 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), false);
  if (!ok || !user) return NextResponse.json({ error: 'Email or password is not right' }, { status: 401 });

  const token = await createSession(user.id, req.headers.get('user-agent'));
  await logEvent({ source: 'audit', action: 'auth.login', message: `${user.name} signed in`, actorId: user.id });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', path: '/', maxAge: SESSION_DAYS * 86_400,
  });
  return res;
}
