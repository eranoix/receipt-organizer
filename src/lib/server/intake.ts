import { q, q1 } from '../db';
import { drive } from '../drive';
import { findOriginal, sha256 } from '../dedup/proof';
import { newTraceId } from '../ids';
import { logEvent, notify } from './events';
import { getSetting } from './settings';

interface FileRow { id: string; name: string; parent_id: string; size: number; first_seen_at: Date; label: string }

export async function intakeScan(limit = 50): Promise<number> {
  const rows = await q<FileRow>(
    `SELECT d.id, d.name, d.parent_id, d.size, d.first_seen_at, ib.label
       FROM drive_items d
       JOIN inbox_folders ib ON ib.folder_id = d.parent_id
       LEFT JOIN receipts r ON r.file_id = d.id
       LEFT JOIN duplicate_candidates dc ON dc.file_id = d.id
      WHERE d.deleted_at IS NULL AND NOT d.is_folder AND r.file_id IS NULL AND dc.id IS NULL
      ORDER BY d.first_seen_at, d.id
      LIMIT $1`, [limit]);
  let n = 0;
  for (const f of rows) {
    try {
      await intakeFile(f);
      n += 1;
    } catch (err) {
      await logEvent({ source: 'sync', level: 'warn', action: 'intake.failed', message: `Could not take in ${f.name}: ${(err as Error).message}`, subjectId: f.id });
    }
  }
  return n;
}

async function intakeFile(f: FileRow): Promise<void> {
  const traceId = newTraceId();
  const bytes = await drive().read(f.id, AbortSignal.timeout(30_000));
  const hash = sha256(bytes);
  await q('UPDATE drive_items SET sha256 = $2 WHERE id = $1', [f.id, hash]);

  if (await getSetting('dedup.enabled')) {
    const unhashed = await q<{ id: string }>(`SELECT id FROM drive_items WHERE sha256 IS NULL AND size = $1 AND id <> $2 AND NOT is_folder AND deleted_at IS NULL`, [f.size, f.id]);
    for (const u of unhashed) {
      try {
        await q('UPDATE drive_items SET sha256 = $2 WHERE id = $1', [u.id, sha256(await drive().read(u.id, AbortSignal.timeout(30_000)))]);
      } catch { /* unreadable now; the backfill will retry */ }
    }
    const others = await q<{ id: string; name: string; sha256: string; first_seen_at: Date; settled: boolean }>(
      `SELECT d.id, d.name, d.sha256, d.first_seen_at,
              (NOT EXISTS (SELECT 1 FROM inbox_folders ib WHERE ib.folder_id = d.parent_id)
               OR EXISTS (SELECT 1 FROM receipts r WHERE r.file_id = d.id AND r.ocr_state <> 'held_duplicate')) AS settled
         FROM drive_items d WHERE d.sha256 = $1 AND d.id <> $2 AND d.deleted_at IS NULL AND NOT d.is_folder`, [hash, f.id]);
    const originalId = findOriginal(
      { id: f.id, name: f.name, sha256: hash, firstSeenAt: f.first_seen_at.getTime(), settled: false },
      others.map((o) => ({ id: o.id, name: o.name, sha256: o.sha256, firstSeenAt: o.first_seen_at.getTime(), settled: o.settled })),
    );
    if (originalId) {
      const orig = await q1<{ name: string; path: string }>('SELECT name, path FROM drive_items WHERE id = $1', [originalId]);
      await q(`INSERT INTO duplicate_candidates (file_id, original_id, sha256, status, trace_id) VALUES ($1, $2, $3, 'suspected', $4) ON CONFLICT (file_id) DO NOTHING`,
        [f.id, originalId, hash, traceId]);
      await q(`INSERT INTO receipts (file_id, ocr_state, trace_id) VALUES ($1, 'held_duplicate', $2) ON CONFLICT (file_id) DO NOTHING`, [f.id, traceId]);
      await logEvent({
        source: 'dedup', level: 'warn', action: 'duplicate.suspected', subjectId: f.id, traceId,
        message: `${f.name} has the same SHA-256 as ${orig?.path ?? originalId}. Held out of review until someone decides.`,
        data: { originalId, sha256: hash },
      });
      await notify({ roles: ['admin', 'member'], pref: 'notify_duplicates', kind: 'duplicate', title: `Possible duplicate: ${f.name}`, body: `Same content as ${orig?.name ?? 'an existing file'}`, link: '/duplicates' });
      return;
    }
  }

  await q(`INSERT INTO receipts (file_id, ocr_state, trace_id) VALUES ($1, 'queued', $2) ON CONFLICT (file_id) DO NOTHING`, [f.id, traceId]);
  await logEvent({ source: 'sync', action: 'intake.new', message: `New receipt in ${f.label}: ${f.name}`, subjectId: f.id, traceId });
}

export async function hashBackfill(limit = 25): Promise<number> {
  const rows = await q<{ id: string }>(`SELECT id FROM drive_items WHERE sha256 IS NULL AND NOT is_folder AND deleted_at IS NULL LIMIT $1`, [limit]);
  for (const r of rows) {
    try {
      const bytes = await drive().read(r.id, AbortSignal.timeout(30_000));
      await q('UPDATE drive_items SET sha256 = $2 WHERE id = $1', [r.id, sha256(bytes)]);
    } catch { /* next pass */ }
  }
  return rows.length;
}
