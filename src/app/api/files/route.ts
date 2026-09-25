import { q1 } from '@/lib/db';
import { api, HttpError, readJson } from '@/lib/server/api';
import { createFolder, deleteItems, listFolder, moveItems, renameItem, rootFolderId } from '@/lib/server/files';

export const GET = api({}, async ({ req, user }) => {
  let folder = req.nextUrl.searchParams.get('folder');
  if (!folder) {
    // Members and viewers start at their first folder, not at a root they cannot open.
    folder = user.role === 'admin' || user.scopePaths.includes('/')
      ? await rootFolderId()
      : (await q1<{ id: string }>(`SELECT id FROM drive_items WHERE path = $1 AND is_folder AND deleted_at IS NULL`, [user.scopePaths[0] ?? '']))?.id ?? '';
    if (!folder) throw new HttpError(404, 'You have not been given access to any folder yet');
  }
  const search = req.nextUrl.searchParams.get('q')?.trim().slice(0, 80) || undefined;
  return listFolder(folder, user, search);
});

type Body =
  | { action: 'createFolder'; parentId: string; name: string }
  | { action: 'rename'; id: string; name: string }
  | { action: 'move'; ids: string[]; targetId: string }
  | { action: 'delete'; ids: string[] };

export const POST = api({}, async ({ req, user, traceId }) => {
  const b = await readJson<Body>(req);
  switch (b.action) {
    case 'createFolder': return createFolder(b.parentId, b.name, user, traceId);
    case 'rename': return renameItem(b.id, b.name, user, traceId);
    case 'move': return moveItems(Array.isArray(b.ids) ? b.ids : [], b.targetId, user, traceId);
    case 'delete': return deleteItems(Array.isArray(b.ids) ? b.ids : [], user, traceId);
    default: throw new HttpError(400, 'Unknown action');
  }
});
