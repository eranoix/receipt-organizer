import { NextResponse, type NextRequest } from 'next/server';
import { newTraceId } from '../ids';
import { limiter } from '../rate-limit';
import { hasRole, SESSION_COOKIE, userFromToken, type Role, type SessionUser } from './auth';

import { HttpError } from './http-error';

export { HttpError };

export interface Ctx<P> {
  req: NextRequest;
  user: SessionUser;
  params: P;
  traceId: string;
}

interface Opts {
  role?: Role;
  limit?: [string, number, number];
}

function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local';
}

export function tooMany(retryAfterMs: number) {
  return NextResponse.json({ error: 'Too many requests. Slow down and try again shortly.' }, {
    status: 429, headers: { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) },
  });
}

export function api<P = Record<string, string>>(opts: Opts, fn: (ctx: Ctx<P>) => Promise<unknown>) {
  return async (req: NextRequest, context: { params: Promise<P> }): Promise<Response> => {
    const traceId = req.headers.get('x-trace-id')?.slice(0, 40).replace(/[^\w-]/g, '') || newTraceId();
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    try {
      if (write) {
        const origin = req.headers.get('origin');
        const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
        if (origin && host && new URL(origin).host !== host) throw new HttpError(403, 'Cross-site request refused');
      }
      const user = await userFromToken(req.cookies.get(SESSION_COOKIE)?.value);
      if (!user) throw new HttpError(401, 'Sign in first');
      const min = opts.role ?? (write ? 'member' : 'viewer');
      if (!hasRole(user, min)) throw new HttpError(403, `This needs the ${min} role`);

      const [name, limit, windowMs] = opts.limit ?? (write ? ['write', 120, 60_000] : ['read', 600, 60_000]);
      const rl = limiter(name, limit, windowMs).hit(`${user.id}:${clientIp(req)}`);
      if (!rl.ok) return tooMany(rl.retryAfterMs);

      const params = (await context.params) ?? ({} as P);
      const out = await fn({ req, user, params, traceId });
      if (out instanceof Response) {
        out.headers.set('x-trace-id', traceId);
        return out;
      }
      return NextResponse.json(out ?? { ok: true }, { headers: { 'x-trace-id': traceId, 'cache-control': 'no-store' } });
    } catch (err) {
      if (err instanceof HttpError) {
        return NextResponse.json({ error: err.message, details: err.details, traceId }, { status: err.status, headers: { 'x-trace-id': traceId } });
      }
      console.error(`[api] ${req.method} ${req.nextUrl.pathname} trace=${traceId}`, err);
      return NextResponse.json({ error: 'Something went wrong on our side.', traceId }, { status: 500, headers: { 'x-trace-id': traceId } });
    }
  };
}

export async function readJson<T>(req: NextRequest, maxBytes = 1_000_000): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Request body too large');
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}

export function intParam(v: string | null, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}
