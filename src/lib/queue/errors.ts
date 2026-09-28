export const PERMANENT_CODES = new Set([
  'nameAlreadyExists',
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

  return { permanent: false, code: code ?? 'unknown', message, retryAfterMs };
}
