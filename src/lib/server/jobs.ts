import { q, q1 } from '../db';
import { drive } from '../drive';
import { proveIdentical } from '../dedup/proof';
import type { SessionUser } from './auth';
import { HttpError } from './http-error';
import { logEvent, resolveDuplicateWarning } from './events';
import { enqueue } from './queue';

interface Cand { id: number; file_id: string; original_id: string; status: string; name: string; original_name: string; original_path: string }

async function loadCandidate(id: number): Promise<Cand | null> {
  return q1<Cand>(
    `SELECT dc.id, dc.file_id, dc.original_id, dc.status, d.name, o.name AS original_name, o.path AS original_path
       FROM duplicate_candidates dc JOIN drive_items d ON d.id = dc.file_id JOIN drive_items o ON o.id = dc.original_id
      WHERE dc.id = $1`, [id]);
}

/** Compare the bytes of a suspected duplicate with its original, right now. */
export async function verifyCandidate(id: number, actorId: number | null, traceId: string | null) {
  const c = await loadCandidate(id);
  if (!c) throw new HttpError(404, 'Duplicate not found');
  const [a, b] = await Promise.all([drive().read(c.file_id, AbortSignal.timeout(30_000)), drive().read(c.original_id, AbortSignal.timeout(30_000))]);
  const proof = proveIdentical(a, b);
  const status = proof.identical ? 'proven' : 'not_identical';
  await q(`UPDATE duplicate_candidates SET status = $2, proof = $3, proven_at = now(), updated_at = now() WHERE id = $1`, [id, status, JSON.stringify(proof)]);
  if (!proof.identical) {
    // Not a copy after all: release it into the normal reading queue.
    await q(`UPDATE receipts SET ocr_state = 'queued' WHERE file_id = $1 AND ocr_state = 'held_duplicate'`, [c.file_id]);
    await resolveDuplicateWarning(c.file_id);
  }
  await logEvent({
    source: 'dedup', level: proof.identical ? 'info' : 'warn', action: proof.identical ? 'duplicate.proven' : 'duplicate.not_identical',
    actorId, traceId, subjectId: c.file_id,
    message: proof.identical
      ? `Byte proof: ${c.name} is identical to ${c.original_path} (${proof.bytesCompared} bytes compared)`
      : `Byte proof failed: ${c.name} differs from ${c.original_name} at byte ${proof.firstMismatchAt}. Kept and sent for reading.`,
    data: { proof },
  });
  return { status, proof };
}

/** Deleting duplicates is a job with progress, never a fire-and-forget loop in a request. */
export async function createDedupDeleteJob(candidateIds: number[], user: SessionUser, traceId: string) {
  const ids = [...new Set(candidateIds.map(Number).filter(Number.isInteger))].slice(0, 500);
  if (ids.length === 0) throw new HttpError(400, 'Select at least one duplicate');
  const ok = await q<{ id: number }>(`SELECT id FROM duplicate_candidates WHERE id = ANY($1) AND status IN ('suspected', 'proven')`, [ids]);
  if (ok.length === 0) throw new HttpError(409, 'None of these can be deleted (already deleted, kept, or not identical)');
  const job = await q1<{ id: number }>(
    `INSERT INTO jobs (kind, status, total, payload, trace_id, created_by) VALUES ('dedup_delete', 'queued', $1, $2, $3, $4) RETURNING id`,
    [ok.length, JSON.stringify({ candidateIds: ok.map((r) => r.id) }), traceId, user.id]);
  await q(`UPDATE duplicate_candidates SET job_id = $2 WHERE id = ANY($1)`, [ok.map((r) => r.id), job!.id]);
  await logEvent({ source: 'dedup', action: 'duplicate.delete_requested', actorId: user.id, traceId, message: `${user.name} asked to delete ${ok.length} duplicate(s). Each is re-proven byte by byte first.` });
  return { jobId: job!.id, total: ok.length };
}

export async function createReprocessJob(fileIds: string[], user: SessionUser, traceId: string) {
  const ids = [...new Set(fileIds.filter((x) => typeof x === 'string'))].slice(0, 1000);
  if (ids.length === 0) throw new HttpError(400, 'Select at least one receipt');
  const job = await q1<{ id: number }>(`INSERT INTO jobs (kind, status, total, payload, trace_id, created_by) VALUES ('bulk_reprocess', 'running', 0, $1, $2, $3) RETURNING id`,
    [JSON.stringify({ fileIds: ids.length }), traceId, user.id]);
  const marked = await q(`UPDATE receipts SET reprocess = true, ocr_state = 'queued', ocr_next_at = NULL, ocr_attempts = 0, ocr_job_id = $2, updated_at = now()
                          WHERE file_id = ANY($1) AND ocr_state IN ('done', 'failed') RETURNING file_id`, [ids, job!.id]);
  await q(`UPDATE jobs SET total = $2, started_at = now() WHERE id = $1`, [job!.id, marked.length]);
  await logEvent({ source: 'ocr', action: 'ocr.bulk_reprocess', actorId: user.id, traceId, message: `${user.name} queued ${marked.length} receipt(s) for re-reading` });
  return { jobId: job!.id, total: marked.length };
}

/** Advance jobs: start queued ones and close finished ones. */
export async function runJobs(): Promise<void> {
  const queued = await q<{ id: number; payload: { candidateIds: number[] }; trace_id: string | null; created_by: number | null }>(
    `UPDATE jobs SET status = 'running', started_at = now() WHERE id IN (SELECT id FROM jobs WHERE status = 'queued' AND kind = 'dedup_delete' ORDER BY id LIMIT 2 FOR UPDATE SKIP LOCKED)
     RETURNING id, payload, trace_id, created_by`);
  for (const job of queued) {
    for (const cid of job.payload.candidateIds) {
      const c = await loadCandidate(cid);
      if (!c || !['suspected', 'proven'].includes(c.status)) {
        await q('UPDATE jobs SET failed = failed + 1 WHERE id = $1', [job.id]);
        continue;
      }
      // The proof is taken again at deletion time, on fresh bytes. A proof
      // from yesterday says nothing about a file that changed this morning.
      let proof;
      try {
        proof = (await verifyCandidate(cid, job.created_by, job.trace_id)).proof;
      } catch (err) {
        await q('UPDATE jobs SET failed = failed + 1 WHERE id = $1', [job.id]);
        await logEvent({ source: 'dedup', level: 'error', action: 'duplicate.verify_failed', traceId: job.trace_id, subjectId: c.file_id, message: `Could not verify ${c.name}: ${(err as Error).message}` });
        continue;
      }
      if (!proof.identical) {
        await q('UPDATE jobs SET failed = failed + 1 WHERE id = $1', [job.id]);
        continue;
      }
      await q(`UPDATE duplicate_candidates SET status = 'deleting', updated_at = now() WHERE id = $1`, [cid]);
      await enqueue({
        kind: 'drive.delete', idempotencyKey: `dedup-delete:${c.file_id}`, traceId: job.trace_id, createdBy: job.created_by, subjectId: c.file_id,
        payload: { itemId: c.file_id, duplicateId: cid, jobId: job.id, name: c.name, originalName: c.original_name, intent: 'delete', proof: { bytes: proof.bytesCompared, sha256: proof.sha256A } },
      });
    }
  }

  const running = await q<{ id: number; kind: string; total: number; done: number; failed: number }>(`SELECT id, kind, total, done, failed FROM jobs WHERE status = 'running'`);
  for (const j of running) {
    if (j.kind === 'bulk_reprocess') {
      const left = await q1<{ n: number }>(`SELECT count(*) AS n FROM receipts WHERE ocr_job_id = $1 AND ocr_state IN ('queued', 'running')`, [j.id]);
      const failed = await q1<{ n: number }>(`SELECT count(*) AS n FROM receipts WHERE ocr_job_id = $1 AND ocr_state = 'failed'`, [j.id]);
      const remaining = left?.n ?? 0;
      await q(`UPDATE jobs SET done = $2, failed = $3, status = CASE WHEN $4::int = 0 THEN 'done' ELSE status END,
                      finished_at = CASE WHEN $4::int = 0 THEN now() ELSE finished_at END WHERE id = $1`,
        [j.id, j.total - remaining - (failed?.n ?? 0), failed?.n ?? 0, remaining]);
    } else if (j.done + j.failed >= j.total) {
      await q(`UPDATE jobs SET status = 'done', finished_at = now() WHERE id = $1`, [j.id]);
    }
  }
}
