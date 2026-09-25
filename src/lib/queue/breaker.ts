/**
 * Circuit breaker as a pure state machine.
 *
 * Kept free of I/O so every transition can be tested exhaustively; the queue
 * persists the state with a compare-and-set on `version`, which is what makes
 * "only one HALF_OPEN trial at a time" hold across several worker processes.
 *
 * Two rules came from real incidents:
 *   - HALF_OPEN admits exactly ONE trial. Letting every waiting caller through
 *     the moment the cooldown ends is a thundering herd against a provider
 *     that has just started to recover.
 *   - A permanent error is not a provider failure. "That name already exists"
 *     proves the provider is up and answering; counting it toward opening the
 *     breaker lets one bad request take down every good one.
 */

export type BreakerMode = 'closed' | 'open' | 'half_open';

export interface BreakerState {
  mode: BreakerMode;
  consecutiveFailures: number;
  openedAt: number | null;
  trialStartedAt: number | null;
  version: number;
}

export interface BreakerConfig {
  /** Consecutive transient failures that open the breaker. */
  failureThreshold: number;
  /** How long to stay OPEN before allowing a trial. */
  cooldownMs: number;
  /** A trial that has not reported back within this window is presumed lost. */
  trialTimeoutMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { failureThreshold: 5, cooldownMs: 30_000, trialTimeoutMs: 60_000 };

export function initialBreaker(): BreakerState {
  return { mode: 'closed', consecutiveFailures: 0, openedAt: null, trialStartedAt: null, version: 0 };
}

export type Admission =
  | { allow: true; trial: boolean; next: BreakerState }
  | { allow: false; retryInMs: number; next: BreakerState };

/** May a call go through right now? Returns the state to persist if it does. */
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

  // half_open: a trial is in flight. Everyone else waits, unless that trial
  // has gone silent for longer than it could possibly take, in which case its
  // worker most likely died and a new trial takes its place.
  const trialAge = now - (s.trialStartedAt ?? 0);
  if (trialAge < cfg.trialTimeoutMs) {
    return { allow: false, retryInMs: Math.max(1_000, cfg.trialTimeoutMs - trialAge), next: s };
  }
  return { allow: true, trial: true, next: { ...s, trialStartedAt: now, version: s.version + 1 } };
}

export type CallResult = 'success' | 'transient' | 'permanent';

/** Fold the result of an admitted call into the state. */
export function record(s: BreakerState, result: CallResult, now: number, cfg: BreakerConfig = DEFAULT_BREAKER): BreakerState {
  const bump = (x: Omit<BreakerState, 'version'>): BreakerState => ({ ...x, version: s.version + 1 });

  if (result === 'success' || result === 'permanent') {
    // The provider answered. For a permanent error that is still proof of
    // life, so it closes a trial and resets the streak without counting.
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

/**
 * Rebuild a breaker from the attempt history, newest first.
 *
 * Used by the startup self-heal: the persisted state may be a HALF_OPEN whose
 * trial died with the previous process. Only transient outcomes count, for the
 * same reason `record` ignores permanent ones.
 */
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
