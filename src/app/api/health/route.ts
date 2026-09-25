import { NextResponse } from 'next/server';
import { q1 } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Unauthenticated liveness for the container healthcheck. Reveals nothing but "up". */
export async function GET() {
  try {
    await q1('SELECT 1');
    return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
