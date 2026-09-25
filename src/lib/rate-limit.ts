/**
 * Sliding-window rate limiter kept in memory. One web process serves this
 * app, so a shared store would add a dependency without adding protection;
 * the interface is small enough to back with Postgres or Redis later.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(readonly limit: number, readonly windowMs: number, private readonly now: () => number = Date.now) {}

  hit(key: string): { ok: boolean; remaining: number; retryAfterMs: number } {
    const t = this.now();
    const from = t - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((x) => x > from);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return { ok: false, remaining: 0, retryAfterMs: list[0] + this.windowMs - t };
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.sweep(from);
    return { ok: true, remaining: this.limit - list.length, retryAfterMs: 0 };
  }

  private sweep(from: number) {
    for (const [k, v] of this.hits) if (!v.some((x) => x > from)) this.hits.delete(k);
  }
}

const g = globalThis as unknown as { __roLimiters?: Map<string, RateLimiter> };

export function limiter(name: string, limit: number, windowMs: number): RateLimiter {
  g.__roLimiters ??= new Map();
  let l = g.__roLimiters.get(name);
  if (!l) {
    l = new RateLimiter(limit, windowMs);
    g.__roLimiters.set(name, l);
  }
  return l;
}
