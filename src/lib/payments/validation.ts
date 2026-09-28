export type PaymentMethodOut = 'pix' | 'transfer' | 'boleto';

export interface PaymentInput {
  method: PaymentMethodOut;
  payee: string;
  amountCents: number;
  pixKey?: string;
  bankCode?: string;
  branch?: string;
  account?: string;
  boletoLine?: string;
  billOccurrenceId?: number | null;
  idempotencyKey: string;
}

export type Validation = { ok: true; value: PaymentInput; details: Record<string, string> } | { ok: false; errors: Record<string, string> };

export function pixKeyKind(key: string): 'email' | 'phone' | 'tax_id' | 'random' | null {
  const k = key.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k)) return 'email';
  if (/^\+55\d{10,11}$/.test(k)) return 'phone';
  if (/^\d{11}$|^\d{14}$/.test(k.replace(/[.\-/]/g, ''))) return 'tax_id';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return 'random';
  return null;
}

export function validatePayment(raw: Partial<PaymentInput>): Validation {
  const errors: Record<string, string> = {};
  const details: Record<string, string> = {};
  const method = raw.method;
  if (method !== 'pix' && method !== 'transfer' && method !== 'boleto') errors.method = 'Choose Pix, transfer or boleto';

  const payee = (raw.payee ?? '').trim();
  if (!payee) errors.payee = 'Who is being paid?';
  else if (payee.length > 120) errors.payee = 'Keep the payee under 120 characters';

  const amount = Number(raw.amountCents);
  if (!Number.isInteger(amount) || amount <= 0) errors.amountCents = 'Amount must be more than zero';
  else if (amount > 100_000_000) errors.amountCents = 'Amounts above R$ 1,000,000.00 need a different channel';

  if (!raw.idempotencyKey || raw.idempotencyKey.length < 8) errors.idempotencyKey = 'Missing request id';

  if (method === 'pix') {
    const kind = pixKeyKind(raw.pixKey ?? '');
    if (!kind) errors.pixKey = 'Not a valid Pix key (email, +55 phone, tax id or random key)';
    else { details.pixKey = raw.pixKey!.trim(); details.pixKeyKind = kind; }
  }
  if (method === 'transfer') {
    if (!/^\d{3}$/.test(raw.bankCode ?? '')) errors.bankCode = 'Bank code has 3 digits';
    if (!/^\d{4}$/.test(raw.branch ?? '')) errors.branch = 'Branch has 4 digits';
    if (!/^\d{3,12}-?[\dxX]$/.test(raw.account ?? '')) errors.account = 'Account looks like 12345-6';
    if (!errors.bankCode && !errors.branch && !errors.account) Object.assign(details, { bankCode: raw.bankCode!, branch: raw.branch!, account: raw.account! });
  }
  if (method === 'boleto') {
    const digits = (raw.boletoLine ?? '').replace(/\D/g, '');
    if (digits.length !== 47 && digits.length !== 48) errors.boletoLine = 'A digitable line has 47 or 48 digits';
    else details.boletoLine = digits;
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { ...(raw as PaymentInput), payee, amountCents: amount }, details };
}
