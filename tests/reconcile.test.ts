import { describe, expect, it } from 'vitest';
import type { DriveItem } from '@/lib/drive/types';
import { decideLock } from '@/lib/sync/lock';
import { applyOverlay, type ListedItem, type PendingOp } from '@/lib/sync/overlay';
import { computePaths, planReconcile, type MirrorItem } from '@/lib/sync/reconcile';

const item = (id: string, parentId: string | null, name: string, extra: Partial<DriveItem> = {}): DriveItem =>
  ({ id, parentId, name, isFolder: false, size: 10, mime: null, etag: 'e1', modifiedAt: '2026-01-01T00:00:00Z', ...extra });
const mirror = (i: DriveItem, firstSeenAt = 0): MirrorItem => ({ id: i.id, parentId: i.parentId, name: i.name, isFolder: i.isFolder, etag: i.etag, size: i.size, firstSeenAt });

describe('planReconcile', () => {
  const root = item('root', null, '', { isFolder: true });
  const inbox = item('inbox', 'root', 'Inbox', { isFolder: true });
  const a = item('a', 'inbox', 'a.pdf');

  it('does nothing when the mirror already matches', () => {
    const p = planReconcile([root, inbox, a].map((x) => mirror(x)), [root, inbox, a], { listingStartedAt: 1e9, protectedIds: new Set() });
    expect(p.upserts).toHaveLength(0);
    expect(p.removals).toHaveLength(0);
  });

  it('picks up new, changed and moved items', () => {
    const moved = { ...a, parentId: 'root' };
    const b = item('b', 'inbox', 'b.pdf');
    const p = planReconcile([root, inbox, a].map((x) => mirror(x)), [root, inbox, moved, b], { listingStartedAt: 1e9, protectedIds: new Set() });
    expect(p.upserts.map((x) => x.id).sort()).toEqual(['a', 'b']);
    expect(p.moved).toEqual(['a']);
  });

  it('removes items the drive no longer has', () => {
    const p = planReconcile([root, inbox, a].map((x) => mirror(x)), [root, inbox], { listingStartedAt: 1e9, protectedIds: new Set() });
    expect(p.removals).toEqual(['a']);
  });

  it('never prunes a registered inbox, even if the listing misses it', () => {
    const p = planReconcile([root, inbox].map((x) => mirror(x)), [root], { listingStartedAt: 1e9, protectedIds: new Set(['inbox']) });
    expect(p.removals).toEqual([]);
    expect(p.kept).toEqual([{ id: 'inbox', reason: 'inbox' }]);
  });

  it('does not judge an item created while the listing was running', () => {
    const fresh = item('new-folder', 'root', 'Scanner', { isFolder: true });
    const p = planReconcile([mirror(root), mirror(fresh, 1_000_000)], [root], { listingStartedAt: 1_000_000 - 5_000, protectedIds: new Set(), graceMs: 60_000 });
    expect(p.removals).toEqual([]);
    expect(p.kept[0]).toMatchObject({ id: 'new-folder', reason: 'too_new' });
  });
});

describe('computePaths', () => {
  it('builds paths from the parent chain, whatever the input order', () => {
    const paths = computePaths([
      { id: 'c', parentId: 'b', name: 'Dairy' }, { id: 'root', parentId: null, name: '' }, { id: 'b', parentId: 'root', name: 'Suppliers' },
    ]);
    expect(paths.get('root')).toBe('/');
    expect(paths.get('c')).toBe('/Suppliers/Dairy');
  });
  it('survives a cycle', () => {
    const paths = computePaths([{ id: 'x', parentId: 'y', name: 'x' }, { id: 'y', parentId: 'x', name: 'y' }]);
    expect(paths.size).toBe(2);
  });
});

describe('sync lock', () => {
  it('is free, re-entrant for its owner, and taken over only when stale', () => {
    expect(decideLock({ owner: null, heartbeatAt: null }, 'w1', 0, 1000)).toEqual({ acquire: true, stolenFrom: null });
    expect(decideLock({ owner: 'w1', heartbeatAt: 0 }, 'w1', 5, 1000)).toEqual({ acquire: true, stolenFrom: null });
    expect(decideLock({ owner: 'w2', heartbeatAt: 0 }, 'w1', 500, 1000)).toMatchObject({ acquire: false, heldBy: 'w2' });
    expect(decideLock({ owner: 'w2', heartbeatAt: 0 }, 'w1', 1000, 1000)).toEqual({ acquire: true, stolenFrom: 'w2' });
  });
});

describe('optimistic overlay', () => {
  const items: ListedItem[] = [
    { id: 'a', parentId: 'inbox', name: 'a.pdf', isFolder: false, size: 1 },
    { id: 'b', parentId: 'inbox', name: 'b.pdf', isFolder: false, size: 1 },
  ];
  const ghost = (o: PendingOp): ListedItem => ({ id: `g${o.id}`, parentId: null, name: o.payload.name ?? '', isFolder: o.kind === 'drive.createFolder', size: 0 });
  const op = (id: number, kind: string, payload: PendingOp['payload'], status: PendingOp['status'] = 'pending'): PendingOp => ({ id, kind, status, attempts: 0, lastError: 'nope', payload });

  it('hides an item being moved away and shows it at its destination', () => {
    const mv = op(1, 'drive.move', { itemId: 'a', targetParentId: 'rent', name: 'a.pdf', snapshot: { name: 'a.pdf', isFolder: false, size: 1 }, intent: 'classify' });
    expect(applyOverlay(items, [mv], 'inbox', ghost).map((i) => i.id)).toEqual(['b']);
    const there = applyOverlay([], [mv], 'rent', ghost);
    expect(there).toHaveLength(1);
    expect(there[0]).toMatchObject({ id: 'a', ghost: true, pending: { label: 'Filing...' } });
  });

  it('shows a rename in place with its new name', () => {
    const out = applyOverlay(items, [op(2, 'drive.move', { itemId: 'b', targetParentId: 'inbox', name: 'renamed.pdf', intent: 'rename' })], 'inbox', ghost);
    expect(out.find((i) => i.id === 'b')).toMatchObject({ name: 'renamed.pdf', pending: { label: 'Renaming...' } });
  });

  it('adds a folder being created, but not twice once it exists', () => {
    const mk = op(3, 'drive.createFolder', { parentId: 'inbox', name: 'New' });
    expect(applyOverlay(items, [mk], 'inbox', ghost)).toHaveLength(3);
    expect(applyOverlay([...items, { id: 'n', parentId: 'inbox', name: 'new', isFolder: true, size: 0 }], [mk], 'inbox', ghost)).toHaveLength(3);
  });

  it('flags a dead operation on the real item instead of pretending it happened', () => {
    const out = applyOverlay(items, [op(4, 'drive.move', { itemId: 'a', targetParentId: 'rent', name: 'a.pdf' }, 'dead')], 'inbox', ghost);
    expect(out.find((i) => i.id === 'a')?.pending).toMatchObject({ tone: 'failed', detail: 'nope' });
  });
});
