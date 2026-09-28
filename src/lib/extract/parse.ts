import { parseMoneyToCents } from '../money';
import type { ExtractedFields, PaymentMethod } from './types';

export interface ParseResult { fields: ExtractedFields; confidence: number; perField: Record<string, number> }

const DATE = /(\d{2})\/(\d{2})\/(\d{4})/;

function toIso(m: RegExpMatchArray | null): string | null {
  if (!m) return null;
  const [, d, mo, y] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (date.getUTCMonth() !== Number(mo) - 1) return null;
  return `${y}-${mo}-${d}`;
}

function labelled(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const m = text.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'mi'));
    if (m) return m[1].trim();
  }
  return null;
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bCo-Op\b/g, 'Co-op');
}

export function parseReceiptText(text: string): ParseResult {
  const t = text.replace(/\r/g, '');
  const per: Record<string, number> = {};

  let method: PaymentMethod | null = null;
  if (/\bPIX\b/i.test(t)) method = 'pix';
  else if (/BOLETO/i.test(t)) method = 'boleto';
  else if (/CARD SLIP|\bCARD\b/i.test(t)) method = 'card';
  else if (/TRANSFER|\bTED\b/i.test(t)) method = 'transfer';
  per.method = method ? 1 : 0;

  let amountCents: number | null = null;
  const amountLabel = labelled(t, ['AMOUNT PAID', 'AMOUNT', 'TOTAL', 'VALUE']);
  if (amountLabel && /\d/.test(amountLabel)) {
    amountCents = parseMoneyToCents(amountLabel);
    per.amountCents = amountCents ? 1 : 0;
  } else {
    const all = [...t.matchAll(/R\$\s*([\d.,]+)/g)].map((m) => parseMoneyToCents(m[1]) ?? 0);
    amountCents = all.length ? Math.max(...all) : null;
    per.amountCents = amountCents ? 0.6 : 0;
  }

  let paymentDate: string | null = toIso(labelled(t, ['PAID ON', 'PAYMENT DATE', 'DATE'])?.match(DATE) ?? null);
  per.paymentDate = paymentDate ? 1 : 0;
  if (!paymentDate) {
    const any = [...t.matchAll(new RegExp(DATE, 'g'))].map((m) => toIso(m)).filter(Boolean) as string[];
    paymentDate = any.sort().at(-1) ?? null;
    per.paymentDate = paymentDate ? 0.6 : 0;
  }

  const payeeRaw = labelled(t, ['TO', 'BENEFICIARY', 'MERCHANT', 'PAYEE']);
  const payee = payeeRaw ? titleCase(payeeRaw.replace(/\s{2,}/g, ' ')) : null;
  per.payee = payee ? 1 : 0;

  const payeeTaxId = labelled(t, ['TAX ID', 'CNPJ', 'CPF']);
  const reference = labelled(t, ['REF', 'REFERENCE', 'DESCRIPTION']);

  const confidence = (per.method + per.amountCents + per.paymentDate + per.payee) / 4;
  return {
    fields: { payee, payeeTaxId, amountCents, paymentDate, method, reference: reference ? titleCase(reference) : null },
    confidence: Math.round(confidence * 100) / 100,
    perField: per,
  };
}
