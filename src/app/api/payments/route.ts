import { q } from '@/lib/db';
import { api, readJson } from '@/lib/server/api';
import { createPayment } from '@/lib/server/payments';
import type { PaymentInput } from '@/lib/payments/validation';

export const GET = api({}, async () => {
  const rows = await q(
    `SELECT p.id, p.method, p.payee, p.amount_cents, p.details, p.status, p.provider_ref, p.receipt_file_id, p.receipt_name, p.error, p.created_at, p.settled_at, p.trace_id,
            b.name AS bill_name, o.due_date, u.name AS created_by_name,
            (SELECT rv.stage FROM receipt_view rv WHERE rv.file_id = p.receipt_file_id) AS receipt_stage
       FROM payments p
       LEFT JOIN bill_occurrences o ON o.id = p.bill_occurrence_id
       LEFT JOIN bills b ON b.id = o.bill_id
       LEFT JOIN users u ON u.id = p.created_by
      ORDER BY p.id DESC LIMIT 100`);
  const openBills = await q(
    `SELECT o.id, o.due_date, o.expected_cents, b.name, b.payee, b.method FROM bill_occurrences o JOIN bills b ON b.id = o.bill_id
      WHERE o.status = 'open' AND o.due_date <= current_date + 30 ORDER BY o.due_date`);
  return { rows, openBills };
});

export const POST = api({ limit: ['payments', 20, 60_000] }, async ({ req, user, traceId }) => {
  const b = await readJson<Partial<PaymentInput>>(req);
  return createPayment(b, user, traceId);
});
