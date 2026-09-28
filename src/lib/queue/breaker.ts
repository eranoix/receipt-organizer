export type BreakerMode = 'closed' | 'open' | 'half_open';

export interface BreakerState {
  mode: BreakerMode;
  consecutiveFailures: number;
  openedAt: number | null;
  trialStartedAt: number | null;
  version: number;
}

export interface BreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
  trialTimeoutMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { failureThreshold: 5, cooldownMs: 30_000, trialTimeoutMs: 60_000 };

export function initialBreaker(): BreakerState {
  return { mode: 'closed', consecutiveFailures: 0, openedAt: null, trialStartedAt: null, version: 0 };
}

export type Admission =
  | { allow: true; trial: boolean; next: BreakerState }
  | { allow: false; retryInMs: number; next: BreakerState };

export function admit(s: BreakerState, now: number, cfg: BreakerConfig = DEFAULT_BREAKER): Admission {
  if (s.mode === 'closed') return { allow: true, trial: false, next: s };

  if (s.mode === 'open') {
    const elapsed = now - (s.openedAt ?? now);
    if (elapsed < cfg.cooldownMs) return { allow: false, retryInMs: cfg.cooldownMs - elapsed, next: s };
    return {
      allow: true,
      trial: true,
      next: { ...s, mode: 'half_open', trialStartedAt: now, version: s.version + 1 },
    };
  }

  const trialAge = now - (s.trialStartedAt ?? 0);
  if (trialAge < cfg.trialTimeoutMs) {
    return { allow: false, retryInMs: Math.max(1_000, cfg.trialTimeoutMs - trialAge), next: s };
  }
  return { allow: true, trial: true, next: { ...s, trialStartedAt: now, version: s.version + 1 } };
}

export type CallResult = 'success' | 'transient' | 'permanent';

export function record(s: BreakerState, result: CallResult, now: number, cfg: BreakerConfig = DEFAULT_BREAKER): BreakerState {
  const bump = (x: Omit<BreakerState, 'version'>): BreakerState => ({ ...x, version: s.version + 1 });

  if (result === 'success' || result === 'permanent') {
    if (s.mode === 'closed' && s.consecutiveFailures === 0) return s;
    return bump({ mode: 'closed', consecutiveFailures: 0, openedAt: null, trialStartedAt: null });
  }

  if (s.mode === 'half_open') {
    return bump({ mode: 'open', consecutiveFailures: s.consecutiveFailures + 1, openedAt: now, trialStartedAt: null });
  }
  const failures = s.consecutiveFailures + 1;
  if (s.mode === 'closed' && failures >= cfg.failureThreshold) {
    return bump({ mode: 'open', consecutiveFailures: failures, openedAt: now, trialStartedAt: null });
  }
  return bump({ ...s, consecutiveFailures: failures });
}

export function rebuild(
  attemptsNewestFirst: { outcome: 'applied' | 'noop' | 'retryable' | 'permanent'; startedAt: number }[],
  version: number,
  cfg: BreakerConfig = DEFAULT_BREAKER,
): BreakerState {
  let streak = 0;
  let newestFailure: number | null = null;
  for (const a of attemptsNewestFirst) {
    if (a.outcome === 'permanent') continue;
    if (a.outcome !== 'retryable') break;
    streak += 1;
    newestFailure ??= a.startedAt;
  }
  if (streak >= cfg.failureThreshold) {
    return { mode: 'open', consecutiveFailures: streak, openedAt: newestFailure, trialStartedAt: null, version: version + 1 };
  }
  return { mode: 'closed', consecutiveFailures: streak, openedAt: null, trialStartedAt: null, version: version + 1 };
}
