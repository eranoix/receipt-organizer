import { q, q1 } from '../db';
import { drive } from '../drive';
import { buildZip } from '../render/zip';
import { pathInScope } from '../scope';
import { applyOverlay, type PendingOp } from '../sync/overlay';
import type { SessionUser } from './auth';
import { HttpError } from './http-error';
import { logEvent } from './events';
import { enqueue } from './queue';

export interface ItemRow {
  id: string; parent_id: string | null; name: string; is_folder: boolean; size: number; mime: string | null; path: string;
  remote_modified_at: Date | null; first_seen_at: Date;
}

const canSee = (user: SessionUser, path: string) => user.role === 'admin' || pathInScope(path, user.scopePaths);

export async function rootFolderId(): Promise<string> {
  const r = await q1<{ id: string }>(`SELECT id FROM drive_items WHERE parent_id IS NULL AND deleted_at IS NULL LIMIT 1`);
  if (!r) throw new HttpError(503, 'The drive has not been synced yet');
  return r.id;
}

/** Load an item the user is allowed to see. Out of scope looks exactly like missing. */
export async function itemForUser(id: string, user: SessionUser): Promise<ItemRow> {
  const it = await q1<ItemRow>(`SELECT * FROM drive_items WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!it || !canSee(user, it.path)) throw new HttpError(404, 'Not found');
  return it;
}

function assertWritable(user: SessionUser, path: string) {
  if (user.role === 'viewer') throw new HttpError(403, 'Viewers cannot change files');
  if (!canSee(user, path)) throw new HttpError(403, 'That folder is outside your access');
}

export async function folderTree(user: SessionUser) {
  const rows = await q<{ id: string; parent_id: string | null; name: string; path: string; files: number; inbox_label: string | null; pending: number }>(
    `SELECT f.id, f.parent_id, f.name, f.path, ib.label AS inbox_label,
            (SELECT count(*) FROM drive_items c WHERE c.parent_id = f.id AND NOT c.is_folder AND c.deleted_at IS NULL) AS files,
            (SELECT count(*) FROM receipt_view rv WHERE rv.parent_id = f.id AND rv.stage IN ('suggested', 'needs_decision', 'reading', 'unreadable')) AS pending
       FROM drive_items f LEFT JOIN inbox_folders ib ON ib.folder_id = f.id
      WHERE f.is_folder AND f.deleted_at IS NULL ORDER BY (ib.label IS NULL), f.path`);
  const visible = rows.filter((r) => canSee(user, r.path));
  // Ancestors of visible folders are shown (so the tree has a shape) but locked.
  const needed = new Set<string>();
  for (const v of visible) {
    let p = v.parent_id;
    while (p) {
      needed.add(p);
      p = rows.find((r) => r.id === p)?.parent_id ?? null;
    }
  }
  return rows
    .filter((r) => canSee(user, r.path) || needed.has(r.id))
    .map((r) => ({ id: r.id, parentId: r.parent_id, name: r.parent_id ? r.name : 'Drive', path: r.path, files: r.files, pending: r.pending, inbox: r.inbox_label, locked: !canSee(user, r.path) }));
}

export async function listFolder(folderId: string, user: SessionUser, search?: string) {
  const folder = await itemForUser(folderId, user);
  if (!folder.is_folder) throw new HttpError(400, 'Not a folder');
  const rows = await q<ItemRow & { stage: string | null; payee: string | null; amount_cents: number | null; payment_date: string | null; method: string | null; confidence: number | null }>(
    `SELECT d.*, rv.stage, rv.payee, rv.amount_cents, rv.payment_date, rv.method, rv.confidence
       FROM drive_items d LEFT JOIN receipt_view rv ON rv.file_id = d.id
      WHERE d.deleted_at IS NULL AND ${search ? `d.path LIKE $1 AND NOT d.is_folder AND (d.name ILIKE $2 OR rv.payee ILIKE $2)` : 'd.parent_id = $1'}
      ORDER BY d.is_folder DESC, lower(d.name) LIMIT 1000`,
    search ? [`${folder.path === '/' ? '' : folder.path}/%`, `%${search}%`] : [folderId]);
  const items = rows.filter((r) => canSee(user, r.path)).map((r) => ({
    id: r.id, parentId: r.parent_id, name: r.name, isFolder: r.is_folder, size: r.size, mime: r.mime, path: r.path,
    modifiedAt: r.remote_modified_at, stage: r.stage, payee: r.payee, amountCents: r.amount_cents, paymentDate: r.payment_date, method: r.method,
  }));
  const ops = await q<PendingOp>(
    `SELECT id, kind, status, attempts, last_error AS "lastError", payload FROM operations
      WHERE kind LIKE 'drive.%'
        AND (status IN ('pending', 'running') OR (status = 'dead' AND updated_at > now() - interval '7 days'))
        AND (payload->>'itemId' = ANY($1) OR payload->>'targetParentId' = $2 OR payload->>'parentId' = $2)`,
    [items.map((i) => i.id), folderId]);
  const overlaid = search ? items : applyOverlay(items, ops, folderId, (o) => ({
    id: `pending-${o.id}`, parentId: folderId, name: o.payload.name ?? '', isFolder: o.kind === 'drive.createFolder' || !!o.payload.snapshot?.isFolder,
    size: o.payload.snapshot?.size ?? 0, mime: null, path: '', modifiedAt: null, stage: null, payee: null, amountCents: null, paymentDate: null, method: null,
  }));
  const crumbs = await q<{ id: string; name: string; parent_id: string | null }>(
    `WITH RECURSIVE up AS (SELECT id, name, parent_id, 0 AS depth FROM drive_items WHERE id = $1
                           UNION ALL SELECT d.id, d.name, d.parent_id, up.depth + 1 FROM drive_items d JOIN up ON d.id = up.parent_id WHERE up.depth < 64)
     SELECT id, name, parent_id FROM up ORDER BY depth DESC`, [folderId]);
  const inbox = await q1<{ label: string }>('SELECT label FROM inbox_folders WHERE folder_id = $1', [folderId]);
  return {
    folder: { id: folder.id, name: folder.parent_id ? folder.name : 'Drive', path: folder.path, inbox: inbox?.label ?? null },
    crumbs: crumbs.map((c) => ({ id: c.id, name: c.parent_id ? c.name : 'Drive' })),
    items: overlaid,
  };
}

async function isProtected(id: string): Promise<string | null> {
  const r = await q1<{ label: string }>('SELECT label FROM inbox_folders WHERE folder_id = $1', [id]);
  if (r) return `"${r.label}" is an inbox; remove it from Settings first`;
  const root = await q1<{ id: string }>('SELECT id FROM drive_items WHERE id = $1 AND parent_id IS NULL', [id]);
  return root ? 'The drive root cannot be changed' : null;
}

function validName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n.length > 120 || /[\\/:*?"<>|]/.test(n) || n.startsWith('.')) throw new HttpError(422, 'Names cannot be empty, start with a dot or contain \\ / : * ? " < > |');
  return n;
}

export async function createFolder(parentId: string, name: unknown, user: SessionUser, traceId: string, inboxLabel?: string) {
  const parent = await itemForUser(parentId, user);
  assertWritable(user, parent.path);
  const n = validName(name);
  const { op } = await enqueue({
    kind: 'drive.createFolder', idempotencyKey: `mkdir:${parentId}:${n.toLowerCase()}:${traceId}`, traceId, createdBy: user.id,
    payload: { parentId, name: n, intent: 'createFolder', ...(inboxLabel ? { inboxLabel } : {}) },
  });
  await logEvent({ source: 'audit', action: 'folder.create', actorId: user.id, traceId, message: `${user.name} created folder ${parent.path === '/' ? '' : parent.path}/${n}` });
  return { operationId: op.id };
}

export async function renameItem(id: string, name: unknown, user: SessionUser, traceId: string) {
  const it = await itemForUser(id, user);
  assertWritable(user, it.path);
  const prot = await isProtected(id);
  if (prot && !(await q1('SELECT 1 FROM inbox_folders WHERE folder_id = $1', [id]))) throw new HttpError(409, prot);
  const n = validName(name);
  if (n === it.name) return { operationId: null };
  const { op } = await enqueue({
    kind: 'drive.move', idempotencyKey: `rename:${id}:${n}:${traceId}`, traceId, createdBy: user.id, subjectId: id,
    payload: { itemId: id, targetParentId: it.parent_id, name: n, intent: 'rename', snapshot: { name: it.name, isFolder: it.is_folder, size: it.size } },
  });
  await logEvent({ source: 'audit', action: 'item.rename', actorId: user.id, traceId, subjectId: id, message: `${user.name} renamed ${it.name} to ${n}` });
  return { operationId: op.id };
}

export async function moveItems(ids: string[], targetId: string, user: SessionUser, traceId: string) {
  const target = await itemForUser(targetId, user);
  if (!target.is_folder) throw new HttpError(400, 'Target is not a folder');
  assertWritable(user, target.path);
  const out: number[] = [];
  for (const id of ids.slice(0, 500)) {
    const it = await itemForUser(id, user);
    assertWritable(user, it.path);
    const prot = await isProtected(id);
    if (prot) throw new HttpError(409, prot);
    if (it.parent_id === targetId) continue;
    if (it.is_folder && (target.path === it.path || target.path.startsWith(`${it.path}/`))) throw new HttpError(422, `Cannot move ${it.name} into itself`);
    const { op } = await enqueue({
      kind: 'drive.move', idempotencyKey: `move:${id}:${targetId}:${traceId}`, traceId, createdBy: user.id, subjectId: id,
      payload: { itemId: id, targetParentId: targetId, targetPath: target.path, name: it.name, intent: 'move', snapshot: { name: it.name, isFolder: it.is_folder, size: it.size } },
    });
    out.push(op.id);
  }
  if (out.length) await logEvent({ source: 'audit', action: 'item.move', actorId: user.id, traceId, message: `${user.name} moved ${out.length} item(s) to ${target.path}` });
  return { operationIds: out };
}

export async function deleteItems(ids: string[], user: SessionUser, traceId: string) {
  const out: number[] = [];
  const names: string[] = [];
  for (const id of ids.slice(0, 500)) {
    const it = await itemForUser(id, user);
    assertWritable(user, it.path);
    const prot = await isProtected(id);
    if (prot) throw new HttpError(409, prot);
    const { op } = await enqueue({
      kind: 'drive.delete', idempotencyKey: `delete:${id}`, traceId, createdBy: user.id, subjectId: id,
      payload: { itemId: id, name: it.name, intent: 'delete', snapshot: { name: it.name, isFolder: it.is_folder, size: it.size } },
    });
    out.push(op.id);
    names.push(it.name);
  }
  if (out.length) await logEvent({ source: 'audit', action: 'item.delete', actorId: user.id, traceId, message: `${user.name} deleted ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}` });
  return { operationIds: out };
}

/** Collect files (expanding folders) the user can see, and zip them with their relative paths. */
export async function zipItems(ids: string[], user: SessionUser): Promise<{ name: string; bytes: Buffer; count: number }> {
  const files: { id: string; rel: string; modified: Date | null }[] = [];
  for (const id of ids.slice(0, 200)) {
    const it = await itemForUser(id, user);
    if (!it.is_folder) {
      files.push({ id: it.id, rel: it.name, modified: it.remote_modified_at });
      continue;
    }
    const base = it.path === '/' ? '' : it.path;
    const inside = await q<ItemRow>(`SELECT * FROM drive_items WHERE deleted_at IS NULL AND NOT is_folder AND path LIKE $1 ORDER BY path`, [`${base}/%`]);
    for (const f of inside) if (canSee(user, f.path)) files.push({ id: f.id, rel: `${it.parent_id ? it.name : 'Drive'}${f.path.slice(base.length)}`, modified: f.remote_modified_at });
  }
  if (files.length === 0) throw new HttpError(400, 'Nothing to download');
  if (files.length > 1000) throw new HttpError(413, 'Too many files for one ZIP; pick a smaller folder');
  const entries = [];
  let total = 0;
  for (const f of files) {
    const data = await drive().read(f.id, AbortSignal.timeout(30_000));
    total += data.length;
    if (total > 200 * 1024 * 1024) throw new HttpError(413, 'That is more than 200 MB; pick a smaller selection');
    entries.push({ name: f.rel, data, modified: f.modified ?? undefined });
  }
  return { name: `receipts-${new Date().toISOString().slice(0, 10)}.zip`, bytes: buildZip(entries), count: entries.length };
}
