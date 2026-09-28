import { q } from '@/lib/db';
import { pathInScope } from '@/lib/scope';
import { api, HttpError, readJson } from '@/lib/server/api';
import { logEvent, resolveDuplicateWarning } from '@/lib/server/events';
import { createDedupDeleteJob, verifyCandidate } from '@/lib/server/jobs';

export const GET = api({}, async ({ user }) => {
  const rows = await q<{ path: string; original_path: string } & Record<string, unknown>>(
    `SELECT dc.id, dc.status, dc.sha256, dc.proof, dc.proven_at, dc.created_at, dc.job_id, dc.trace_id,
            d.id AS file_id, d.name, d.path, d.size, d.mime, o.id AS original_id, o.name AS original_name, o.path AS original_path
       FROM duplicate_candidates dc JOIN drive_items d ON d.id = dc.file_id JOIN drive_items o ON o.id = dc.original_id
      ORDER BY CASE dc.status WHEN 'suspected' THEN 0 WHEN 'proven' THEN 1 WHEN 'deleting' THEN 2 ELSE 3 END, dc.created_at DESC`);
  const visible = user.role === 'admin' ? rows : rows.filter((r) => pathInScope(r.path, user.scopePaths) && pathInScope(r.original_path, user.scopePaths));
  const jobs = await q(`SELECT id, status, total, done, failed, created_at, finished_at FROM jobs WHERE kind = 'dedup_delete' ORDER BY id DESC LIMIT 5`);
  return { rows: visible, jobs };
});

export const POST = api({}, async ({ req, user, traceId }) => {
  const b = await readJson<{ action?: 'verify' | 'keep' | 'delete'; ids?: number[] }>(req);
  const ids = (b.ids ?? []).map(Number).filter(Number.isInteger).slice(0, 200);
  if (ids.length === 0) throw new HttpError(400, 'Select at least one duplicate');
  if (b.action === 'verify') {
    const results = [];
    for (const id of ids) results.push({ id, ...(await verifyCandidate(id, user.id, traceId)) });
    return { results };
  }
  if (b.action === 'keep') {
    const kept = await q<{ file_id: string }>(`UPDATE duplicate_candidates SET status = 'kept', decided_by = $2, updated_at = now() WHERE id = ANY($1) AND status IN ('suspected', 'proven') RETURNING file_id`, [ids, user.id]);
    await q(`UPDATE receipts SET ocr_state = 'queued' WHERE file_id = ANY($1) AND ocr_state = 'held_duplicate'`, [kept.map((k) => k.file_id)]);
    for (const k of kept) await resolveDuplicateWarning(k.file_id);
    await logEvent({ source: 'dedup', action: 'duplicate.kept', actorId: user.id, traceId, message: `${user.name} kept ${kept.length} file(s) flagged as duplicates; they go on to be read and filed` });
    return { kept: kept.length };
  }
  if (b.action === 'delete') {
    if (user.role !== 'admin') throw new HttpError(403, 'Only admins can delete duplicates');
    return createDedupDeleteJob(ids, user, traceId);
  }
  throw new HttpError(400, 'Unknown action');
});
