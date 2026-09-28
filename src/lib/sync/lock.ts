export interface LockState { owner: string | null; heartbeatAt: number | null }

export type LockDecision = { acquire: true; stolenFrom: string | null } | { acquire: false; heldBy: string; ageMs: number };

export function decideLock(lock: LockState, me: string, now: number, staleMs: number): LockDecision {
  if (!lock.owner || lock.owner === me) return { acquire: true, stolenFrom: null };
  const age = now - (lock.heartbeatAt ?? 0);
  if (age >= staleMs) return { acquire: true, stolenFrom: lock.owner };
  return { acquire: false, heldBy: lock.owner, ageMs: age };
}
