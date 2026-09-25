import { q, q1 } from '@/lib/db';
import { api, HttpError, readJson } from '@/lib/server/api';
import { logEvent } from '@/lib/server/events';

/** Manual overrides: unmatch a wrong match, skip a month, or match by hand. */
export const POST = api<{ id: string }>({}, async ({ req, user, params, traceId }) => {
  const b = await readJson<{ action?: 'unmatch' | 'skip' | 'reopen' | 'match'; fileId?: string }>(req);
  const id = Number(params.id);
  const occ = await q1<{ status: string; name: string; due_date: string }>(`SELECT o.status, b.name, o.due_date FROM bill_occurrences o JOIN bills b ON b.id = o.bill_id WHERE o.id = $1`, [id]);
  if (!occ) throw new HttpError(404, 'Not found');
  if (b.action === 'unmatch' || b.action === 'reopen') {
    await q(`UPDATE bill_occurrences SET status = 'open', receipt_file_id = NULL, match_score = NULL, match_kind = NULL, matched_at = NULL WHERE id = $1`, [id]);
  } else if (b.action === 'skip') {
    await q(`UPDATE bill_occurrences SET status = 'skipped' WHERE id = $1 AND status = 'open'`, [id]);
  } else if (b.action === 'match' && b.fileId) {
    await q(`UPDATE bill_occurrences SET status = 'paid', receipt_file_id = $2, match_kind = 'manual', match_score = NULL, matched_at = now() WHERE id = $1`, [id, b.fileId]);
  } else {
    throw new HttpError(400, 'Unknown action');
  }
  await logEvent({ source: 'audit', action: `bill.${b.action}`, actorId: user.id, traceId, message: `${user.name} chose "${b.action}" for ${occ.name} due ${occ.due_date}` });
  return { ok: true };
});
