import { q, q1 } from '../db';
import { drive } from '../drive';
import { extractor, FIELD_KEYS, RateLimitedError, UnreadableError, type ExtractedFields } from '../extract';
import { matchAll } from './bills';
import { refreshSuggestion } from './classify';

const COLS: Record<keyof ExtractedFields, string> = {
  payee: 'payee', payeeTaxId: 'payee_tax_id', amountCents: 'amount_cents', paymentDate: 'payment_date', method: 'method', reference: 'reference',
};
export const FIELD_COLUMNS = COLS;

interface Claimed {
  file_id: string; ocr_attempts: number; reprocess: boolean; ocr_job_id: number | null; trace_id: string | null; edited_fields: string[];
  payee: string | null; payee_tax_id: string | null; amount_cents: number | null; payment_date: string | null; method: string | null; reference: string | null;
}

export function currentFields(r: Pick<Claimed, 'payee' | 'payee_tax_id' | 'amount_cents' | 'payment_date' | 'method' | 'reference'>): ExtractedFields {
  return {
    payee: r.payee, payeeTaxId: r.payee_tax_id, amountCents: r.amount_cents, paymentDate: r.payment_date,
    method: r.method as ExtractedFields['method'], reference: r.reference,
  };
}

export function changedFields(before: ExtractedFields, after: ExtractedFields): (keyof ExtractedFields)[] {
  return FIELD_KEYS.filter((k) => (before[k] ?? null) !== (after[k] ?? null));
}

/**
 * Read queued receipts, a few at a time, in the background.
 *
 * A request only marks receipts `queued`; this loop drains them at whatever
 * pace the provider allows. A rate-limit answer is not a
 * failure: the receipt goes back in line with the provider's Retry-After and
 * the rest of the batch is released instead of hammering it.
 */
export async function drainOcr(limit = 5): Promise<{ read: number; rateLimited: boolean }> {
  const claimed = await q<Claimed>(
    `UPDATE receipts SET ocr_state = 'running', updated_at = now()
      WHERE file_id IN (SELECT file_id FROM receipts
                         WHERE ocr_state = 'queued' AND (ocr_next_at IS NULL OR ocr_next_at <= now())
                         ORDER BY ocr_next_at NULLS FIRST, created_at, file_id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [limit]);
  let read = 0;
  for (let i = 0; i < claimed.length; i += 1) {
    const r = claimed[i];
    const outcome = await readOne(r);
    if (outcome === 'rate_limited') {
      const rest = claimed.slice(i + 1).map((c) => c.file_id);
      if (rest.length) await q(`UPDATE receipts SET ocr_state = 'queued' WHERE file_id = ANY($1)`, [rest]);
      return { read, rateLimited: true };
    }
    if (outcome === 'ok') read += 1;
  }
  return { read, rateLimited: false };
}

async function readOne(r: Claimed): Promise<'ok' | 'failed' | 'rate_limited' | 'retry'> {
  const file = await q1<{ name: string; mime: string | null; deleted_at: Date | null; in_inbox: boolean }>(
    `SELECT d.name, d.mime, d.deleted_at, EXISTS (SELECT 1 FROM inbox_folders ib WHERE ib.folder_id = d.parent_id) AS in_inbox
       FROM drive_items d WHERE d.id = $1`, [r.file_id]);
  const trigger = r.ocr_job_id ? 'bulk' : r.reprocess ? 'reprocess' : file?.in_inbox ? 'intake' : 'backfill';
  const provider = extractor().name;
  const started = Date.now();

  if (!file || file.deleted_at) {
    await q(`UPDATE receipts SET ocr_state = 'failed', ocr_error = 'file no longer exists' WHERE file_id = $1`, [r.file_id]);
    return 'failed';
  }

  try {
    const bytes = await drive().read(r.file_id, AbortSignal.timeout(30_000));
    const res = await extractor().extract({ bytes, name: file.name, mime: file.mime }, AbortSignal.timeout(60_000));
    const duration = Date.now() - started;
    const before = currentFields(r);
    const hadFields = r.payee != null || r.amount_cents != null || r.payment_date != null;

    if (r.reprocess && hadFields) {
      // A reprocess never overwrites silently. Identical output is recorded
      // as a plain run; any difference becomes a proposal a person reviews.
      const diff = changedFields(before, res.fields);
      const status = diff.length ? 'proposed' : 'ok';
      const run = await q1<{ id: number }>(
        `INSERT INTO extraction_runs (file_id, provider, trigger, status, fields, raw_text, confidence, duration_ms, trace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [r.file_id, provider, trigger, status, JSON.stringify(res.fields), res.rawText, res.confidence, duration, r.trace_id]);
      await q(`UPDATE receipts SET ocr_state = 'done', ocr_attempts = 0, ocr_error = NULL, reprocess = false, proposal_run_id = $2, updated_at = now() WHERE file_id = $1`,
        [r.file_id, diff.length ? run!.id : null]);
      return 'ok';
    }

    // First reading: take the fields, except any a person already typed in.
    const sets: string[] = [];
    const vals: unknown[] = [r.file_id];
    for (const k of FIELD_KEYS) {
      if (r.edited_fields.includes(k)) continue;
      vals.push(res.fields[k]);
      sets.push(`${COLS[k]} = $${vals.length}`);
    }
    vals.push(res.confidence);
    sets.push(`confidence = $${vals.length}`);
    await q(`UPDATE receipts SET ${sets.join(', ')}, ocr_state = 'done', ocr_attempts = 0, ocr_error = NULL, reprocess = false, updated_at = now() WHERE file_id = $1`, vals);
    await q(`INSERT INTO extraction_runs (file_id, provider, trigger, status, fields, raw_text, confidence, duration_ms, trace_id)
             VALUES ($1, $2, $3, 'ok', $4, $5, $6, $7, $8)`,
      [r.file_id, provider, trigger, JSON.stringify(res.fields), res.rawText, res.confidence, duration, r.trace_id]);
    await refreshSuggestion(r.file_id);
    await matchAll();
    return 'ok';
  } catch (err) {
    const duration = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RateLimitedError) {
      await q(`INSERT INTO extraction_runs (file_id, provider, trigger, status, error, duration_ms, trace_id) VALUES ($1, $2, $3, 'rate_limited', $4, $5, $6)`,
        [r.file_id, provider, trigger, message, duration, r.trace_id]);
      await q(`UPDATE receipts SET ocr_state = 'queued', ocr_next_at = now() + make_interval(secs => $2) WHERE file_id = $1`, [r.file_id, err.retryAfterMs / 1000]);
      return 'rate_limited';
    }
    const permanent = err instanceof UnreadableError;
    const attempts = r.ocr_attempts + 1;
    await q(`INSERT INTO extraction_runs (file_id, provider, trigger, status, error, duration_ms, trace_id) VALUES ($1, $2, $3, 'failed', $4, $5, $6)`,
      [r.file_id, provider, trigger, message, duration, r.trace_id]);
    if (permanent || attempts >= 3) {
      await q(`UPDATE receipts SET ocr_state = 'failed', ocr_attempts = $2, ocr_error = $3, reprocess = false, updated_at = now() WHERE file_id = $1`, [r.file_id, attempts, message]);
      return 'failed';
    }
    await q(`UPDATE receipts SET ocr_state = 'queued', ocr_attempts = $2, ocr_error = $3, ocr_next_at = now() + make_interval(secs => $4) WHERE file_id = $1`,
      [r.file_id, attempts, message, 5 * 2 ** attempts]);
    return 'retry';
  }
}
