import { q, q1, tx } from '../db';
import { drive } from '../drive';
import { decideLock } from '../sync/lock';
import { planReconcile, type MirrorItem } from '../sync/reconcile';
import { logEvent } from './events';
import { applyItems, markDeleted } from './mirror';

export const LOCK_STALE_MS = 2 * 60_000;

export async function ensureSyncState(): Promise<void> {
  await q(`INSERT INTO sync_state (name) VALUES ('drive') ON CONFLICT DO NOTHING`);
}

async function acquire(me: string): Promise<boolean> {
  return tx(async (c) => {
    const row = await q1<{ lock_owner: string | null; lock_heartbeat_at: Date | null }>(
      `SELECT lock_owner, lock_heartbeat_at FROM sync_state WHERE name = 'drive' FOR UPDATE`, [], c);
    const d = decideLock({ owner: row?.lock_owner ?? null, heartbeatAt: row?.lock_heartbeat_at?.getTime() ?? null }, me, Date.now(), LOCK_STALE_MS);
    if (!d.acquire) return false;
    await q(`UPDATE sync_state SET lock_owner = $1, lock_heartbeat_at = now() WHERE name = 'drive'`, [me], c);
    if (d.stolenFrom) {
      await logEvent({ source: 'sync', level: 'warn', action: 'sync.lock_reclaimed', message: `Sync lock held by ${d.stolenFrom} went stale and was taken over`, data: { from: d.stolenFrom } }, c);
    }
    return true;
  });
}

async function release(me: string) {
  await q(`UPDATE sync_state SET lock_owner = NULL, lock_heartbeat_at = NULL WHERE name = 'drive' AND lock_owner = $1`, [me]);
}

async function recordError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  await q(`UPDATE sync_state SET last_error = $1, last_error_at = now() WHERE name = 'drive'`, [msg]);
  await logEvent({ source: 'sync', level: 'warn', action: 'sync.failed', message: `Drive sync failed: ${msg}` });
}

export async function deltaSync(me: string): Promise<{ changes: number; skipped?: boolean }> {
  if (!(await acquire(me))) return { changes: 0, skipped: true };
  try {
    const st = await q1<{ cursor: string | null }>(`SELECT cursor FROM sync_state WHERE name = 'drive'`);
    const page = await drive().delta(st?.cursor ?? null, AbortSignal.timeout(60_000));
    if (page.reset) {
      const items = page.changes.flatMap((c) => (c.type === 'upsert' ? [c.item] : []));
      const r = await reconcileWith(items, Date.now(), null, 'Initial listing');
      await q(`UPDATE sync_state SET cursor = $1, last_delta_at = now(), last_full_at = now(), last_error = NULL WHERE name = 'drive'`, [page.cursor]);
      return { changes: r.upserts + r.removed };
    }
    const upserts = page.changes.flatMap((c) => (c.type === 'upsert' ? [c.item] : []));
    const deletes = page.changes.flatMap((c) => (c.type === 'delete' ? [c.id] : []));
    await applyItems(upserts);
    await markDeleted(deletes);
    await q(`UPDATE sync_state SET cursor = $1, last_delta_at = now(), last_error = NULL WHERE name = 'drive'`, [page.cursor]);
    if (page.changes.length) {
      await logEvent({ source: 'sync', action: 'sync.delta', message: `Applied ${upserts.length} change(s) and ${deletes.length} removal(s) from the drive`, data: { upserts: upserts.length, deletes: deletes.length } });
    }
    return { changes: page.changes.length };
  } catch (err) {
    await recordError(err);
    return { changes: 0 };
  } finally {
    await release(me);
  }
}

export async function fullReconcile(me: string, actorId: number | null = null): Promise<{ upserts: number; removed: number; kept: number } | null> {
  if (!(await acquire(me))) return null;
  try {
    const started = Date.now();
    const remote = await drive().listAll(AbortSignal.timeout(120_000));
    const out = await reconcileWith(remote, started, actorId, 'Full reconciliation');
    await q(`UPDATE sync_state SET last_full_at = now(), full_requested_at = NULL, last_error = NULL WHERE name = 'drive'`);
    return out;
  } catch (err) {
    await recordError(err);
    return null;
  } finally {
    await release(me);
  }
}

async function reconcileWith(remote: Awaited<ReturnType<ReturnType<typeof drive>['listAll']>>, listingStartedAt: number, actorId: number | null, label: string) {
  const mirror = (await q<{ id: string; parent_id: string | null; name: string; is_folder: boolean; etag: string | null; size: number; first_seen_at: Date }>(
    'SELECT id, parent_id, name, is_folder, etag, size, first_seen_at FROM drive_items WHERE deleted_at IS NULL')).map<MirrorItem>((m) => ({
    id: m.id, parentId: m.parent_id, name: m.name, isFolder: m.is_folder, etag: m.etag, size: m.size, firstSeenAt: m.first_seen_at.getTime(),
  }));
  const inboxes = await q<{ folder_id: string }>('SELECT folder_id FROM inbox_folders');
  const plan = planReconcile(mirror, remote, { listingStartedAt, protectedIds: new Set(inboxes.map((i) => i.folder_id)) });
  await applyItems(plan.upserts);
  const removed = await markDeleted(plan.removals);
  const changed = plan.upserts.length + removed;
  await logEvent({
    source: 'sync',
    level: plan.kept.some((k) => k.reason === 'inbox') ? 'warn' : 'info',
    action: 'sync.reconcile',
    actorId,
    message: `${label}: ${remote.length} items listed, ${plan.upserts.length} updated (${plan.moved.length} moved), ${removed} removed` +
      (plan.kept.length ? `, ${plan.kept.length} kept on purpose` : '') + (changed === 0 ? '. Mirror already matched.' : ''),
    data: { listed: remote.length, upserts: plan.upserts.length, moved: plan.moved.length, removed, kept: plan.kept },
  });
  return { upserts: plan.upserts.length, removed, kept: plan.kept.length };
}
