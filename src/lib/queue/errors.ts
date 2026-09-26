/**
 * Decides whether a failed operation is retried or parked in the dead-letter
 * queue. The provider's own error code is the most reliable signal, so every
 * error type here carries it forward instead of flattening it into a message.
 */

/** Codes that mean "asking again will get the same answer". */
export const PERMANENT_CODES = new Set([
  'nameAlreadyExists', // a name collision never resolves by waiting
  'itemNotFound',
  'accessDenied',
  'invalidRequest',
  'quotaLimitReached',
  'notSupported',
  'validationFailed',
  'declined',
]);

export class PermanentError extends Error {
  override readonly name = 'PermanentError';
  constructor(message: string, readonly code = 'permanent') {
    super(message);
  }
}

export class TransientError extends Error {
  override readonly name = 'TransientError';
  constructor(message: string, readonly code = 'transient', readonly retryAfterMs?: number) {
    super(message);
  }
}

export interface ErrorVerdict {
  permanent: boolean;
  code: string;
  message: string;
  /** A server-provided wait (Retry-After). Respected over our own backoff when longer. */
  retryAfterMs?: number;
}

export function classifyError(err: unknown): ErrorVerdict {
  const message = err instanceof Error ? err.message : String(err);
  const e = (err ?? {}) as {
    name?: string; code?: unknown; status?: unknown; retryAfterMs?: unknown;
    body?: { error?: { code?: unknown } };
  };

  if (err instanceof PermanentError) return { permanent: true, code: err.code, message };
  if (err instanceof TransientError) return { permanent: false, code: err.code, message, retryAfterMs: err.retryAfterMs };

  if (e.name === 'AbortError' || e.name === 'TimeoutError') {
    return { permanent: false, code: 'timeout', message: message || 'timed out' };
  }

  // Provider error body first: `{ error: { code: 'nameAlreadyExists' } }`.
  // The HTTP status alone cannot tell a name collision from other conflicts.
  const bodyCode = typeof e.body?.error?.code === 'string' ? e.body.error.code : undefined;
  const code = bodyCode ?? (typeof e.code === 'string' ? e.code : undefined);
  const status = typeof e.status === 'number' ? e.status : undefined;
  const retryAfterMs = typeof e.retryAfterMs === 'number' ? e.retryAfterMs : undefined;

  if (code && PERMANENT_CODES.has(code)) return { permanent: true, code, message };
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(code)) {
    return { permanent: false, code, message };
  }

  if (status !== undefined) {
    if (status === 429) return { permanent: false, code: code ?? 'throttled', message, retryAfterMs };
    if (status === 408 || status >= 500) return { permanent: false, code: code ?? `http_${status}`, message, retryAfterMs };
    if (status >= 400) return { permanent: true, code: code ?? `http_${status}`, message };
  }

  // Unknown shapes are treated as transient: the attempt budget and the
  // deadline still bound them, and a human sees them in the DLQ if they never
  // clear. Guessing "permanent" would drop work on the floor.
  return { permanent: false, code: code ?? 'unknown', message, retryAfterMs };
}
