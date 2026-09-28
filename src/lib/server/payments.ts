import { q, q1 } from '../db';
import { formatCents } from '../money';
import { paymentProvider } from '../payments/provider';
import { validatePayment, type PaymentInput } from '../payments/validation';
import type { SessionUser } from './auth';
import { HttpError } from './http-error';
import { logEvent, notify } from './events';
import { enqueue } from './queue';

export async function createPayment(raw: Partial<PaymentInput>, user: SessionUser, traceId: string) {
  const v = validatePayment(raw);
  if (!v.ok) throw new HttpError(422, 'Check the highlighted fields', v.errors);
  const p = v.value;
  if (p.billOccurrenceId) {
    const occ = await q1<{ status: string }>('SELECT status FROM bill_occurrences WHERE id = $1', [p.billOccurrenceId]);
    if (!occ) throw new HttpError(422, 'That bill no longer exists', { billOccurrenceId: 'not found' });
  }
  const inserted = await q1<{ id: number }>(
    `INSERT INTO payments (idempotency_key, method, payee, amount_cents, details, bill_occurrence_id, status, trace_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'submitted', $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [p.idempotencyKey, p.method, p.payee, p.amountCents, JSON.stringify(v.details), p.billOccurrenceId ?? null, traceId, user.id]);
  if (!inserted) {
    const existing = await q1<{ id: number }>('SELECT id FROM payments WHERE idempotency_key = $1', [p.idempotencyKey]);
    return { id: existing!.id, duplicate: true };
  }
  await enqueue({ kind: 'payment.send', idempotencyKey: `payment:${inserted.id}`, payload: { paymentId: inserted.id, payee: p.payee, intent: 'pay' }, traceId, createdBy: user.id, maxAttempts: 4 });
  await logEvent({ source: 'payment', action: 'payment.created', message: `${user.name} sent ${formatCents(p.amountCents)} to ${p.payee} by ${p.method}`, actorId: user.id, traceId });
  return { id: inserted.id, duplicate: false };
}

export async function settlePayments(): Promise<number> {
  const rows = await q<{ id: number; idempotency_key: string; method: 'pix' | 'transfer' | 'boleto'; payee: string; amount_cents: number; details: Record<string, string>; provider_ref: string; sent_at: Date; trace_id: string | null; created_by: number | null }>(
    `SELECT * FROM payments WHERE status = 'processing' AND provider_ref IS NOT NULL ORDER BY id LIMIT 20`);
  let settled = 0;
  for (const p of rows) {
    const req = { idempotencyKey: p.idempotency_key, method: p.method, payee: p.payee, amountCents: p.amount_cents, details: p.details };
    const st = await paymentProvider().status(p.provider_ref, req, p.sent_at.getTime(), AbortSignal.timeout(15_000));
    if (st.state === 'processing') continue;
    if (st.state === 'failed') {
      await q(`UPDATE payments SET status = 'failed', error = $2 WHERE id = $1`, [p.id, st.error]);
      continue;
    }
    const inbox = await q1<{ folder_id: string; label: string }>('SELECT folder_id, label FROM inbox_folders ORDER BY is_primary DESC, created_at LIMIT 1');
    await q(`UPDATE payments SET status = 'paid', settled_at = now(), receipt_name = $2 WHERE id = $1`, [p.id, st.receipt.name]);
    if (inbox) {
      await enqueue({
        kind: 'drive.upload', idempotencyKey: `payment-receipt:${p.id}`, traceId: p.trace_id, createdBy: p.created_by,
        payload: { parentId: inbox.folder_id, name: st.receipt.name, contentB64: st.receipt.bytes.toString('base64'), paymentId: p.id, intent: 'upload' },
      });
    }
    await logEvent({ source: 'payment', action: 'payment.settled', traceId: p.trace_id, message: `Payment to ${p.payee} settled (${p.provider_ref}); receipt ${st.receipt.name} is on its way to ${inbox?.label ?? 'the inbox'}` });
    await notify({ roles: ['admin'], pref: 'notify_bills', kind: 'payment', title: `Paid ${formatCents(p.amount_cents)} to ${p.payee}`, body: 'The receipt will appear in the inbox shortly.', link: '/payments' });
    settled += 1;
  }
  return settled;
}
