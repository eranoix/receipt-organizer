import { q } from '@/lib/db';
import { api, HttpError, readJson } from '@/lib/server/api';
import { ensureOccurrences, matchAll, todayIso } from '@/lib/server/bills';
import { logEvent } from '@/lib/server/events';

export const GET = api({}, async () => {
  const bills = await q(`SELECT b.*, f.path AS folder_path FROM bills b LEFT JOIN drive_items f ON f.id = b.folder_id ORDER BY b.active DESC, b.due_day`);
  const occurrences = await q(
    `SELECT o.id, o.bill_id, o.due_date, o.expected_cents, o.status, o.match_score, o.match_kind, o.matched_at, o.receipt_file_id,
            d.name AS receipt_name, r.amount_cents AS paid_cents, r.payment_date AS paid_on,
            (SELECT p.status FROM payments p WHERE p.bill_occurrence_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_status
       FROM bill_occurrences o
       LEFT JOIN drive_items d ON d.id = o.receipt_file_id
       LEFT JOIN receipts r ON r.file_id = o.receipt_file_id
      WHERE o.due_date >= (current_date - interval '4 months')
      ORDER BY o.due_date DESC`);
  return { bills, occurrences, today: todayIso() };
});

export const POST = api({}, async ({ req, user, traceId }) => {
  const b = await readJson<{ name?: string; payee?: string; amountCents?: number; tolerancePct?: number; dueDay?: number; method?: string; folderId?: string | null }>(req);
  const errors: Record<string, string> = {};
  if (!b.name?.trim()) errors.name = 'Give the bill a name';
  if (!b.payee?.trim()) errors.payee = 'Who gets paid?';
  if (!Number.isInteger(b.amountCents) || (b.amountCents ?? 0) <= 0) errors.amountCents = 'Amount must be positive';
  if (!Number.isInteger(b.dueDay) || (b.dueDay ?? 0) < 1 || (b.dueDay ?? 0) > 28) errors.dueDay = 'Due day is 1 to 28';
  if (!['pix', 'boleto', 'card', 'transfer'].includes(String(b.method))) errors.method = 'Pick a method';
  const tol = Number(b.tolerancePct ?? 0);
  if (!Number.isInteger(tol) || tol < 0 || tol > 100) errors.tolerancePct = '0 to 100';
  if (Object.keys(errors).length) throw new HttpError(422, 'Check the highlighted fields', errors);
  const [bill] = await q<{ id: number }>(
    `INSERT INTO bills (name, payee, amount_cents, tolerance_pct, due_day, method, folder_id, starts_on) VALUES ($1, $2, $3, $4, $5, $6, $7, date_trunc('month', current_date)::date) RETURNING id`,
    [b.name!.trim(), b.payee!.trim(), b.amountCents, tol, b.dueDay, b.method, b.folderId ?? null]);
  await ensureOccurrences();
  await matchAll();
  await logEvent({ source: 'audit', action: 'bill.created', actorId: user.id, traceId, message: `${user.name} added the recurring bill "${b.name}"` });
  return { id: bill.id };
});
