import { q } from '../db';
import { addDays, dueDatesBetween } from '../bills/recurrence';
import { matchReceipts, type OpenOccurrence, type ReceiptFacts } from '../bills/matching';
import { formatCents } from '../money';
import { logEvent } from './events';

export const todayIso = () => new Date().toISOString().slice(0, 10);

export async function ensureOccurrences(today = todayIso()): Promise<number> {
  const bills = await q<{ id: number; due_day: number; starts_on: string; amount_cents: number }>('SELECT id, due_day, starts_on, amount_cents FROM bills WHERE active');
  const from = `${addDays(today, -125).slice(0, 7)}-01`;
  const to = addDays(today, 45);
  let n = 0;
  for (const b of bills) {
    const dates = dueDatesBetween({ dueDay: b.due_day, startsOn: b.starts_on }, from, to);
    if (dates.length === 0) continue;
    const r = await q(`INSERT INTO bill_occurrences (bill_id, due_date, expected_cents)
                       SELECT $1, d, $2 FROM unnest($3::date[]) d ON CONFLICT DO NOTHING RETURNING id`, [b.id, b.amount_cents, dates]);
    n += r.length;
  }
  return n;
}

export async function matchAll(): Promise<number> {
  const occ = await q<{ id: number; bill_id: number; due_date: string; expected_cents: number; tolerance_pct: number; payee: string; name: string }>(
    `SELECT o.id, o.bill_id, o.due_date, o.expected_cents, b.tolerance_pct, b.payee, b.name
       FROM bill_occurrences o JOIN bills b ON b.id = o.bill_id WHERE o.status = 'open'`);
  if (occ.length === 0) return 0;
  const rec = await q<{ file_id: string; payment_date: string | null; amount_cents: number | null; payee: string | null; name: string; trace_id: string | null }>(
    `SELECT r.file_id, r.payment_date, r.amount_cents, r.payee, d.name, r.trace_id
       FROM receipts r
       JOIN drive_items d ON d.id = r.file_id AND d.deleted_at IS NULL
       LEFT JOIN duplicate_candidates dc ON dc.file_id = r.file_id
      WHERE r.ocr_state = 'done'
        AND (dc.id IS NULL OR dc.status IN ('not_identical', 'kept'))
        AND NOT EXISTS (SELECT 1 FROM bill_occurrences o WHERE o.receipt_file_id = r.file_id)`);
  const occurrences: OpenOccurrence[] = occ.map((o) => ({ id: o.id, billId: o.bill_id, dueDate: o.due_date, expectedCents: o.expected_cents, tolerancePct: o.tolerance_pct, payee: o.payee }));
  const receipts: ReceiptFacts[] = rec.map((r) => ({ fileId: r.file_id, paymentDate: r.payment_date, amountCents: r.amount_cents, payee: r.payee }));
  const matches = matchReceipts(occurrences, receipts);
  for (const m of matches) {
    const updated = await q(`UPDATE bill_occurrences SET status = 'paid', receipt_file_id = $2, match_score = $3, match_kind = 'auto', matched_at = now()
                             WHERE id = $1 AND status = 'open' RETURNING id`, [m.occurrenceId, m.fileId, m.score]);
    if (updated.length === 0) continue;
    const o = occ.find((x) => x.id === m.occurrenceId)!;
    const r = rec.find((x) => x.file_id === m.fileId)!;
    await logEvent({
      source: 'audit', action: 'bill.matched', subjectId: m.fileId, traceId: r.trace_id,
      message: `${o.name} due ${o.due_date} marked paid by ${r.name} (${formatCents(r.amount_cents)}, match ${Math.round(m.score * 100)}%)`,
      data: { occurrenceId: o.id, score: m.score },
    });
  }
  return matches.length;
}
