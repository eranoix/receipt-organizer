import { createHash } from 'node:crypto';
import { PermanentError } from '../queue/errors';
import { renderReceipt, type ReceiptStyle } from '../render/receipt';
import { slug } from '../text';

export interface SendRequest {
  idempotencyKey: string;
  method: 'pix' | 'transfer' | 'boleto';
  payee: string;
  amountCents: number;
  details: Record<string, string>;
}

export type PaymentStatus =
  | { state: 'processing' }
  | { state: 'failed'; error: string }
  | { state: 'paid'; paidOn: string; receipt: { name: string; bytes: Buffer } };

export interface PaymentProvider {
  readonly name: string;
  /** Idempotent: sending the same key twice returns the same reference. */
  send(req: SendRequest, signal?: AbortSignal): Promise<{ ref: string }>;
  status(ref: string, req: SendRequest, sentAt: number, signal?: AbortSignal): Promise<PaymentStatus>;
}

/**
 * A payment provider that settles every payment a few seconds after it is
 * sent and hands back a receipt, the way a real bank API delivers a proof of
 * payment. A payee containing "DECLINE" is refused, to show the failure path.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  constructor(private readonly settleMs = 3_000, private readonly now: () => number = Date.now) {}

  async send(req: SendRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (/decline/i.test(req.payee)) throw new PermanentError('payment declined by the provider (demo rule: payee contains "DECLINE")', 'declined');
    return { ref: `MOCK-${createHash('sha256').update(req.idempotencyKey).digest('hex').slice(0, 12).toUpperCase()}` };
  }

  async status(ref: string, req: SendRequest, sentAt: number, signal?: AbortSignal): Promise<PaymentStatus> {
    signal?.throwIfAborted();
    if (this.now() - sentAt < this.settleMs) return { state: 'processing' };
    const paidOn = new Date(this.now()).toISOString().slice(0, 10);
    const style: ReceiptStyle = req.method === 'transfer' ? 'transfer' : req.method;
    const bytes = renderReceipt({
      style, payee: req.payee, amountCents: req.amountCents, paidOn,
      time: new Date(this.now()).toISOString().slice(11, 16), pixKey: req.details.pixKey, reference: `payment ${ref}`,
    }, 'pdf');
    return { state: 'paid', paidOn, receipt: { name: `${req.method}_${paidOn}_${slug(req.payee)}_${ref.slice(-6).toLowerCase()}.pdf`, bytes } };
  }
}

const g = globalThis as unknown as { __roPayments?: PaymentProvider };
export function paymentProvider(): PaymentProvider {
  g.__roPayments ??= new MockPaymentProvider(Number(process.env.PAYMENT_SETTLE_MS ?? 3_000));
  return g.__roPayments;
}
