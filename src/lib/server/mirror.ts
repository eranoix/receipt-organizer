import { q, type Db } from '../db';
import type { DriveItem } from '../drive/types';

export async function upsertItems(items: DriveItem[], db?: Db): Promise<void> {
  if (items.length === 0) return;
  await q(
    `INSERT INTO drive_items (id, parent_id, name, is_folder, size, mime, etag, remote_modified_at)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::bool[], $5::int[], $6::text[], $7::text[], $8::timestamptz[])
     ON CONFLICT (id) DO UPDATE SET
       parent_id = EXCLUDED.parent_id, name = EXCLUDED.name, is_folder = EXCLUDED.is_folder,
       sha256 = CASE WHEN drive_items.size = EXCLUDED.size THEN drive_items.sha256 ELSE NULL END,
       size = EXCLUDED.size, mime = EXCLUDED.mime, etag = EXCLUDED.etag,
       remote_modified_at = EXCLUDED.remote_modified_at, deleted_at = NULL, updated_at = now()`,
    [
      items.map((i) => i.id), items.map((i) => i.parentId), items.map((i) => i.name), items.map((i) => i.isFolder),
      items.map((i) => i.size), items.map((i) => i.mime), items.map((i) => i.etag), items.map((i) => i.modifiedAt),
    ],
    db,
  );
}

export async function markDeleted(ids: string[], db?: Db): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await q<{ id: string }>(
    `WITH RECURSIVE sub AS (
       SELECT id FROM drive_items WHERE id = ANY($1)
       UNION SELECT c.id FROM drive_items c JOIN sub ON c.parent_id = sub.id)
     UPDATE drive_items d SET deleted_at = now(), updated_at = now()
       FROM sub WHERE d.id = sub.id AND d.deleted_at IS NULL RETURNING d.id`,
    [ids], db,
  );
  return r.length;
}

export async function recomputePaths(db?: Db): Promise<void> {
  await q(
    `WITH RECURSIVE t AS (
       SELECT id, '/'::text AS path, 0 AS depth FROM drive_items WHERE parent_id IS NULL AND deleted_at IS NULL
       UNION ALL
       SELECT c.id, CASE WHEN t.path = '/' THEN '/' || c.name ELSE t.path || '/' || c.name END, t.depth + 1
         FROM drive_items c JOIN t ON c.parent_id = t.id
        WHERE c.deleted_at IS NULL AND t.depth < 64)
     UPDATE drive_items d SET path = t.path FROM t WHERE d.id = t.id AND d.path IS DISTINCT FROM t.path`,
    [], db,
  );
}

export async function applyItems(items: DriveItem[], db?: Db): Promise<void> {
  await upsertItems(items, db);
  await recomputePaths(db);
}
