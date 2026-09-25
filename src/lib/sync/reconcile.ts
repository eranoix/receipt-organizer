/**
 * Full reconciliation between the mirror and a complete listing of the drive.
 *
 * Delta sync is the fast path; this is the safety net for when a delta was
 * missed, a cursor expired or a change arrived out of order. It produces a
 * plan, not side effects, so the dangerous part (what gets removed from the
 * mirror) can be tested on its own.
 *
 * Removal is guarded twice:
 *   - registered inbox folders are never pruned by reconciliation, even if the
 *     listing does not show them; losing an inbox silently is how receipts
 *     stop being read without anyone noticing;
 *   - an item first seen after the listing started cannot be judged by that
 *     listing. A folder created while a slow listing was paging looks
 *     "orphaned" to it and would otherwise be deleted from the mirror.
 */

import type { DriveItem } from '../drive/types';

export interface MirrorItem {
  id: string;
  parentId: string | null;
  name: string;
  isFolder: boolean;
  etag: string | null;
  size: number;
  firstSeenAt: number;
}

export interface ReconcilePlan {
  upserts: DriveItem[];
  /** Subset of upserts whose parent or name changed. */
  moved: string[];
  removals: string[];
  kept: { id: string; reason: 'inbox' | 'too_new' }[];
}

export function planReconcile(
  mirror: MirrorItem[],
  remote: DriveItem[],
  opts: { listingStartedAt: number; protectedIds: Set<string>; graceMs?: number },
): ReconcilePlan {
  const grace = opts.graceMs ?? 60_000;
  const byId = new Map(mirror.map((m) => [m.id, m]));
  const remoteIds = new Set(remote.map((r) => r.id));
  const plan: ReconcilePlan = { upserts: [], moved: [], removals: [], kept: [] };

  for (const r of remote) {
    const m = byId.get(r.id);
    if (!m) {
      plan.upserts.push(r);
      continue;
    }
    const relocated = m.parentId !== r.parentId || m.name !== r.name;
    if (relocated || m.etag !== r.etag || m.size !== r.size || m.isFolder !== r.isFolder) {
      plan.upserts.push(r);
      if (relocated) plan.moved.push(r.id);
    }
  }

  for (const m of mirror) {
    if (remoteIds.has(m.id)) continue;
    if (opts.protectedIds.has(m.id)) plan.kept.push({ id: m.id, reason: 'inbox' });
    else if (m.firstSeenAt > opts.listingStartedAt - grace) plan.kept.push({ id: m.id, reason: 'too_new' });
    else plan.removals.push(m.id);
  }
  return plan;
}

/** Full path of every item from its parent chain. Cycles and orphans get a best-effort path. */
export function computePaths(items: { id: string; parentId: string | null; name: string }[]): Map<string, string> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = new Map<string, string>();
  const walk = (id: string, depth: number): string => {
    const cached = out.get(id);
    if (cached !== undefined) return cached;
    const it = byId.get(id);
    if (!it || it.parentId === null || depth > 64) return '/';
    const parentPath = byId.has(it.parentId) ? walk(it.parentId, depth + 1) : '/';
    const p = parentPath === '/' ? `/${it.name}` : `${parentPath}/${it.name}`;
    out.set(id, p);
    return p;
  };
  for (const i of items) out.set(i.id, i.parentId === null ? '/' : walk(i.id, 0));
  return out;
}
