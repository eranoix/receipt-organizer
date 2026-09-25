import { describe, expect, it } from 'vitest';
import { admit, initialBreaker, rebuild, record, type BreakerConfig } from '@/lib/queue/breaker';

const cfg: BreakerConfig = { failureThreshold: 3, cooldownMs: 1_000, trialTimeoutMs: 5_000 };

describe('breaker state machine', () => {
  it('stays closed below the threshold and opens at it', () => {
    let s = initialBreaker();
    s = record(s, 'transient', 0, cfg);
    s = record(s, 'transient', 0, cfg);
    expect(s.mode).toBe('closed');
    s = record(s, 'transient', 10, cfg);
    expect(s.mode).toBe('open');
    expect(s.openedAt).toBe(10);
  });

  it('a success resets the failure streak', () => {
    let s = record(record(initialBreaker(), 'transient', 0, cfg), 'transient', 0, cfg);
    s = record(s, 'success', 0, cfg);
    expect(s.consecutiveFailures).toBe(0);
  });

  it('permanent errors are proof of life, not failures', () => {
    let s = initialBreaker();
    for (let i = 0; i < 10; i += 1) s = record(s, 'permanent', i, cfg);
    expect(s.mode).toBe('closed');
    expect(s.consecutiveFailures).toBe(0);
  });

  it('rejects calls while open and says how long to wait', () => {
    const open = { ...initialBreaker(), mode: 'open' as const, openedAt: 0, consecutiveFailures: 3 };
    const a = admit(open, 400, cfg);
    expect(a.allow).toBe(false);
    if (!a.allow) expect(a.retryInMs).toBe(600);
  });

  it('admits ONE trial after the cooldown and rejects everyone else meanwhile', () => {
    const open = { ...initialBreaker(), mode: 'open' as const, openedAt: 0, consecutiveFailures: 3 };
    const first = admit(open, 1_000, cfg);
    expect(first.allow && first.trial).toBe(true);
    const halfOpen = first.next;
    expect(halfOpen.mode).toBe('half_open');
    expect(halfOpen.version).toBe(open.version + 1);
    for (let i = 0; i < 20; i += 1) expect(admit(halfOpen, 1_001 + i, cfg).allow).toBe(false);
  });

  it('replaces a trial that went silent for longer than the trial timeout', () => {
    const half = { ...initialBreaker(), mode: 'half_open' as const, openedAt: 0, trialStartedAt: 1_000, consecutiveFailures: 3 };
    expect(admit(half, 5_999, cfg).allow).toBe(false);
    const again = admit(half, 6_000, cfg);
    expect(again.allow && again.trial).toBe(true);
  });

  it('a successful trial closes; a failed trial reopens with a fresh cooldown', () => {
    const half = { ...initialBreaker(), mode: 'half_open' as const, openedAt: 0, trialStartedAt: 1_000, consecutiveFailures: 3 };
    expect(record(half, 'success', 1_100, cfg).mode).toBe('closed');
    const reopened = record(half, 'transient', 1_100, cfg);
    expect(reopened.mode).toBe('open');
    expect(reopened.openedAt).toBe(1_100);
  });

  it('rebuilds from history, skipping permanent outcomes', () => {
    const h = [
      { outcome: 'retryable' as const, startedAt: 50 },
      { outcome: 'permanent' as const, startedAt: 40 },
      { outcome: 'retryable' as const, startedAt: 30 },
      { outcome: 'retryable' as const, startedAt: 20 },
      { outcome: 'applied' as const, startedAt: 10 },
    ];
    const s = rebuild(h, 7, cfg);
    expect(s.mode).toBe('open');
    expect(s.openedAt).toBe(50);
    expect(s.consecutiveFailures).toBe(3);
    expect(rebuild(h.slice(3), 7, cfg).mode).toBe('closed');
  });
});
