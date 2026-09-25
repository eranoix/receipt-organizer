import { q, q1 } from '@/lib/db';
import { api, HttpError, readJson } from '@/lib/server/api';
import { logEvent } from '@/lib/server/events';
import { createFolder, rootFolderId } from '@/lib/server/files';

/**
 * Inboxes: register an existing folder, or create a new one through the
 * queue (it becomes an inbox the moment the drive confirms it). Removing an
 * inbox only unregisters it; the folder and its files stay.
 */
export const POST = api({ role: 'admin' }, async ({ req, user, traceId }) => {
  const b = await readJson<{ folderId?: string; name?: string; label?: string }>(req);
  const label = String(b.label ?? b.name ?? '').trim();
  if (label.length < 2 || label.length > 40) throw new HttpError(422, 'Label must be 2 to 40 characters');
  if (b.folderId) {
    const f = await q1<{ path: string }>(`SELECT path FROM drive_items WHERE id = $1 AND is_folder AND deleted_at IS NULL`, [b.folderId]);
    if (!f) throw new HttpError(404, 'Folder not found');
    await q(`INSERT INTO inbox_folders (folder_id, label) VALUES ($1, $2) ON CONFLICT (folder_id) DO UPDATE SET label = EXCLUDED.label`, [b.folderId, label]);
    await logEvent({ source: 'audit', action: 'inbox.added', actorId: user.id, traceId, message: `${user.name} made ${f.path} an inbox ("${label}")` });
    return { ok: true };
  }
  const out = await createFolder(await rootFolderId(), b.name ?? label, user, traceId, label);
  await logEvent({ source: 'audit', action: 'inbox.created', actorId: user.id, traceId, message: `${user.name} created a new inbox "${label}"` });
  return out;
});

export const DELETE = api({ role: 'admin' }, async ({ req, user, traceId }) => {
  const b = await readJson<{ folderId?: string }>(req);
  const n = await q1<{ n: number }>('SELECT count(*) AS n FROM inbox_folders');
  if ((n?.n ?? 0) <= 1) throw new HttpError(409, 'Keep at least one inbox');
  await q('DELETE FROM inbox_folders WHERE folder_id = $1', [b.folderId]);
  await q(`UPDATE inbox_folders SET is_primary = true WHERE folder_id = (SELECT folder_id FROM inbox_folders ORDER BY is_primary DESC, created_at LIMIT 1) AND NOT EXISTS (SELECT 1 FROM inbox_folders WHERE is_primary)`);
  await logEvent({ source: 'audit', action: 'inbox.removed', actorId: user.id, traceId, message: `${user.name} removed an inbox (the folder itself was kept)` });
  return { ok: true };
});
