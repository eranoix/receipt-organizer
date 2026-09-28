import { q, q1 } from '../db';
import { FIELD_KEYS, type ExtractedFields } from '../extract/types';
import { pathInScope } from '../scope';
import type { SessionUser } from './auth';
import { HttpError } from './http-error';
import { matchAll } from './bills';
import { refreshSuggestion } from './classify';
import { logEvent } from './events';
import { itemForUser } from './files';
import { changedFields, currentFields, FIELD_COLUMNS } from './ocr';
import { enqueue } from './queue';

const canSee = (user: SessionUser, path: string) => user.role === 'admin' || pathInScope(path, user.scopePaths);

export async function reviewList(user: SessionUser, filter: { stage?: string; inbox?: string; q?: string }) {
  const vals: unknown[] = [];
  const cond = ['rv.in_inbox'];
  if (filter.stage && filter.stage !== 'all') { vals.push(filter.stage); cond.push(`rv.stage = $${vals.length}`); }
  if (filter.inbox) { vals.push(filter.inbox); cond.push(`rv.parent_id = $${vals.length}`); }
  if (filter.q) { vals.push(`%${filter.q}%`); cond.push(`(rv.name ILIKE $${vals.length} OR rv.payee ILIKE $${vals.length})`); }
  const rows = await q<Record<string, unknown> & { path: string; file_id: string }>(
    `SELECT rv.file_id, rv.name, rv.path, rv.parent_id, rv.mime, rv.stage, rv.payee, rv.amount_cents, rv.payment_date, rv.method, rv.confidence,
            rv.suggestion_folder_id, rv.suggestion_confidence, rv.proposal_run_id, sf.path AS suggestion_path, ib.label AS inbox_label,
            (SELECT o.status FROM operations o WHERE o.kind = 'drive.move' AND o.payload->>'itemId' = rv.file_id AND o.status IN ('pending', 'running', 'dead')
              ORDER BY o.id DESC LIMIT 1) AS filing_status,
            (SELECT o.last_error FROM operations o WHERE o.kind = 'drive.move' AND o.payload->>'itemId' = rv.file_id AND o.status = 'dead' ORDER BY o.id DESC LIMIT 1) AS filing_error
       FROM receipt_view rv
       JOIN inbox_folders ib ON ib.folder_id = rv.parent_id
       LEFT JOIN drive_items sf ON sf.id = rv.suggestion_folder_id
      WHERE ${cond.join(' AND ')} AND rv.stage <> 'duplicate'
      ORDER BY CASE rv.stage WHEN 'suggested' THEN 0 WHEN 'needs_decision' THEN 1 WHEN 'unreadable' THEN 2 ELSE 3 END, rv.first_seen_at DESC
      LIMIT 500`, vals);
  const counts = await q<{ stage: string; n: number }>(`SELECT stage, count(*) AS n FROM receipt_view WHERE in_inbox AND stage <> 'duplicate' GROUP BY 1`);
  const inboxes = await q<{ folder_id: string; label: string }>('SELECT folder_id, label FROM inbox_folders ORDER BY is_primary DESC, label');
  return { rows: rows.filter((r) => canSee(user, r.path)), counts: Object.fromEntries(counts.map((c) => [c.stage, c.n])), inboxes };
}

export async function receiptDetail(fileId: string, user: SessionUser) {
  await itemForUser(fileId, user);
  const r = await q1<Record<string, unknown> & { proposal_run_id: number | null; suggestion_alternatives: { folderId: string; confidence: number; reasons: string[] }[] }>(
    `SELECT rv.*, sf.path AS suggestion_path, r.ocr_attempts FROM receipt_view rv LEFT JOIN receipts r ON r.file_id = rv.file_id
       LEFT JOIN drive_items sf ON sf.id = rv.suggestion_folder_id WHERE rv.file_id = $1`, [fileId]);
  if (!r) throw new HttpError(404, 'Not found');
  const runs = await q(`SELECT id, provider, trigger, status, confidence, error, duration_ms, created_at FROM extraction_runs WHERE file_id = $1 ORDER BY id DESC LIMIT 10`, [fileId]);
  let proposal = null;
  if (r.proposal_run_id) {
    const run = await q1<{ id: number; fields: ExtractedFields; confidence: number; created_at: Date }>('SELECT id, fields, confidence, created_at FROM extraction_runs WHERE id = $1', [r.proposal_run_id]);
    if (run) {
      const before = currentFields(r as never);
      proposal = { runId: run.id, confidence: run.confidence, createdAt: run.created_at, before, after: run.fields, changed: changedFields(before, run.fields) };
    }
  }
  const altIds = (r.suggestion_alternatives ?? []).map((a) => a.folderId);
  const altPaths = altIds.length ? await q<{ id: string; path: string }>('SELECT id, path FROM drive_items WHERE id = ANY($1)', [altIds]) : [];
  const bill = await q1(`SELECT o.id, o.due_date, o.expected_cents, o.match_score, b.name FROM bill_occurrences o JOIN bills b ON b.id = o.bill_id WHERE o.receipt_file_id = $1`, [fileId]);
  const dup = await q1(`SELECT dc.id, dc.status, o.path AS original_path FROM duplicate_candidates dc JOIN drive_items o ON o.id = dc.original_id WHERE dc.file_id = $1`, [fileId]);
  return {
    receipt: r,
    alternatives: (r.suggestion_alternatives ?? []).map((a) => ({ ...a, path: altPaths.find((p) => p.id === a.folderId)?.path ?? '?' })),
    runs, proposal, bill, duplicate: dup,
  };
}

function coerce(k: keyof ExtractedFields, v: unknown): unknown {
  if (v === null || v === '') return null;
  switch (k) {
    case 'amountCents': {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0 || n > 100_000_000) throw new HttpError(422, 'Amount must be a positive number of cents', { amountCents: 'invalid' });
      return n;
    }
    case 'paymentDate':
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(422, 'Date must be YYYY-MM-DD', { paymentDate: 'invalid' });
      return v;
    case 'method':
      if (!['pix', 'boleto', 'card', 'transfer', 'cash'].includes(String(v))) throw new HttpError(422, 'Unknown payment method', { method: 'invalid' });
      return v;
    default:
      if (typeof v !== 'string' || v.length > 200) throw new HttpError(422, `${k} must be text under 200 characters`, { [k]: 'invalid' });
      return v.trim();
  }
}

export async function updateFields(fileId: string, patch: Partial<Record<keyof ExtractedFields, unknown>>, user: SessionUser, traceId: string) {
  const it = await itemForUser(fileId, user);
  if (user.role === 'viewer') throw new HttpError(403, 'Viewers cannot edit');
  const r = await q1<Record<string, unknown>>('SELECT * FROM receipts WHERE file_id = $1', [fileId]);
  if (!r) throw new HttpError(404, 'This file has not been read yet');
  const before = currentFields(r as never);
  const sets: string[] = [];
  const vals: unknown[] = [fileId];
  const edited: string[] = [];
  for (const k of FIELD_KEYS) {
    if (!(k in patch)) continue;
    const v = coerce(k, patch[k]);
    if ((before[k] ?? null) === v) continue;
    vals.push(v);
    sets.push(`${FIELD_COLUMNS[k]} = $${vals.length}`);
    edited.push(k);
  }
  if (edited.length === 0) return { changed: [] };
  vals.push(edited);
  await q(`UPDATE receipts SET ${sets.join(', ')}, edited_fields = (SELECT array_agg(DISTINCT x) FROM unnest(edited_fields || $${vals.length}::text[]) x), updated_at = now() WHERE file_id = $1`, vals);
  await logEvent({ source: 'audit', action: 'receipt.edited', actorId: user.id, traceId, subjectId: fileId, message: `${user.name} corrected ${edited.join(', ')} on ${it.name}`, data: { before, patch } });
  await refreshSuggestion(fileId);
  await matchAll();
  return { changed: edited };
}

export async function decideProposal(fileId: string, accept: boolean, fields: string[] | undefined, user: SessionUser, traceId: string) {
  const it = await itemForUser(fileId, user);
  if (user.role === 'viewer') throw new HttpError(403, 'Viewers cannot decide');
  const r = await q1<Record<string, unknown> & { proposal_run_id: number | null }>('SELECT * FROM receipts WHERE file_id = $1', [fileId]);
  if (!r?.proposal_run_id) throw new HttpError(409, 'There is no proposal waiting for this receipt');
  const run = await q1<{ id: number; fields: ExtractedFields; confidence: number }>('SELECT id, fields, confidence FROM extraction_runs WHERE id = $1', [r.proposal_run_id]);
  const changed = changedFields(currentFields(r as never), run!.fields);
  const take = accept ? changed.filter((k) => !fields || fields.includes(k)) : [];
  if (take.length) {
    const sets = take.map((k, i) => `${FIELD_COLUMNS[k]} = $${i + 2}`);
    await q(`UPDATE receipts SET ${sets.join(', ')}, confidence = $${take.length + 2},
                    edited_fields = ARRAY(SELECT unnest(edited_fields) EXCEPT SELECT unnest($${take.length + 3}::text[])) WHERE file_id = $1`,
      [fileId, ...take.map((k) => run!.fields[k]), run!.confidence, take]);
  }
  await q(`UPDATE receipts SET proposal_run_id = NULL, updated_at = now() WHERE file_id = $1`, [fileId]);
  await q(`UPDATE extraction_runs SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [run!.id, accept ? 'accepted' : 'rejected', user.id]);
  await logEvent({ source: 'audit', action: accept ? 'ocr.proposal_accepted' : 'ocr.proposal_rejected', actorId: user.id, traceId, subjectId: fileId,
    message: accept ? `${user.name} accepted ${take.length} re-read field(s) on ${it.name}: ${take.join(', ') || 'none'}` : `${user.name} kept the current fields on ${it.name}` });
  if (take.length) {
    await refreshSuggestion(fileId);
    await matchAll();
  }
  return { applied: take };
}

export async function confirmFiling(items: { fileId: string; folderId?: string | null }[], user: SessionUser, traceId: string) {
  if (user.role === 'viewer') throw new HttpError(403, 'Viewers cannot file receipts');
  const queued: { fileId: string; operationId: number }[] = [];
  const skipped: { fileId: string; reason: string }[] = [];
  for (const { fileId, folderId } of items.slice(0, 500)) {
    const r = await q1<{ name: string; path: string; stage: string; suggestion_folder_id: string | null; suggestion_confidence: number | null; size: number }>(
      'SELECT name, path, stage, suggestion_folder_id, suggestion_confidence, size FROM receipt_view WHERE file_id = $1', [fileId]);
    if (!r || !canSee(user, r.path)) { skipped.push({ fileId, reason: 'not found' }); continue; }
    if (!['suggested', 'needs_decision', 'unreadable'].includes(r.stage)) { skipped.push({ fileId, reason: `is ${r.stage}` }); continue; }
    const target = folderId ?? r.suggestion_folder_id;
    if (!target) { skipped.push({ fileId, reason: 'no folder chosen' }); continue; }
    const folder = await q1<{ path: string; is_folder: boolean }>(`SELECT path, is_folder FROM drive_items WHERE id = $1 AND deleted_at IS NULL`, [target]);
    if (!folder?.is_folder || !canSee(user, folder.path)) { skipped.push({ fileId, reason: 'folder not available' }); continue; }
    const { op } = await enqueue({
      kind: 'drive.move', idempotencyKey: `classify:${fileId}:${target}`, traceId, createdBy: user.id, subjectId: fileId,
      payload: { itemId: fileId, targetParentId: target, targetPath: folder.path, name: r.name, intent: 'classify', snapshot: { name: r.name, isFolder: false, size: r.size } },
    });
    const how = folderId && folderId !== r.suggestion_folder_id ? 'chose' : `confirmed the suggestion (${Math.round((r.suggestion_confidence ?? 0) * 100)}%)`;
    await logEvent({ source: 'audit', action: 'receipt.confirmed', actorId: user.id, traceId, subjectId: fileId, message: `${user.name} ${how} ${folder.path} for ${r.name}` });
    queued.push({ fileId, operationId: op.id });
  }
  return { queued, skipped };
}

export async function reprocessOne(fileId: string, user: SessionUser, traceId: string) {
  const it = await itemForUser(fileId, user);
  if (user.role === 'viewer') throw new HttpError(403, 'Viewers cannot reprocess');
  const r = await q<{ file_id: string }>(`UPDATE receipts SET reprocess = true, ocr_state = 'queued', ocr_next_at = NULL, ocr_attempts = 0, updated_at = now()
                                         WHERE file_id = $1 AND ocr_state IN ('done', 'failed') RETURNING file_id`, [fileId]);
  if (r.length === 0) throw new HttpError(409, 'This receipt is already being read');
  await logEvent({ source: 'ocr', action: 'ocr.reprocess', actorId: user.id, traceId, subjectId: fileId, message: `${user.name} asked to re-read ${it.name}` });
  return { queued: true };
}
