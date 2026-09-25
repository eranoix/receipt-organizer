/**
 * Renders the fictional receipts used by the seed, the tests and the mock
 * payment provider. Every document says it is a demo, every tax id is
 * all-nines (invalid by construction) and every bank is "999".
 */

import { buildReceiptPdf, type PdfLine } from './pdf';
import { encodeGrayPng, rasterizeReceipt } from './png';

export type ReceiptStyle = 'pix' | 'boleto' | 'card' | 'transfer';

export interface ReceiptSpec {
  style: ReceiptStyle;
  payee: string;
  payeeTaxId?: string;
  amountCents: number;
  /** YYYY-MM-DD */
  paidOn: string;
  time?: string;
  dueOn?: string;
  payer?: string;
  reference?: string;
  pixKey?: string;
  /** Leave the payee line out, the way a torn or badly scanned slip would. */
  omitPayee?: boolean;
  /** A photo with no readable text layer at all. */
  noTextLayer?: boolean;
  seed?: number;
}

export const PNG_TEXT_KEY = 'ReceiptText';

function brDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function brMoney(cents: number): string {
  const s = (cents / 100).toFixed(2);
  const [w, f] = s.split('.');
  return `R$ ${w.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${f}`;
}

function txid(spec: ReceiptSpec): string {
  let h = 2166136261;
  for (const c of `${spec.payee}|${spec.amountCents}|${spec.paidOn}|${spec.seed ?? 0}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return `E999${h.toString(16).toUpperCase().padStart(8, '0')}DEMO`;
}

type Line = { text: string; bold?: boolean; invert?: boolean; rule?: boolean };

export function receiptLines(spec: ReceiptSpec): Line[] {
  const payer = spec.payer ?? 'JUNIPER LANE BAKERY';
  const tax = spec.payeeTaxId ?? '99.999.999/9999-99';
  const payee = spec.payee.toUpperCase();
  const time = spec.time ?? '10:24';
  const L: Line[] = [];
  const rule = () => L.push({ text: '', rule: true });

  if (spec.style === 'pix') {
    L.push({ text: 'PIX TRANSFER RECEIPT', bold: true, invert: true }, { text: 'FICTIONAL DEMO BANK - 999' });
    rule();
    L.push({ text: `DATE: ${brDate(spec.paidOn)} ${time}` }, { text: `AMOUNT: ${brMoney(spec.amountCents)}`, bold: true });
    rule();
    L.push({ text: `FROM: ${payer}` });
    if (!spec.omitPayee) L.push({ text: `TO: ${payee}` }, { text: `TAX ID: ${tax}` });
    if (spec.pixKey) L.push({ text: `PIX KEY: ${spec.pixKey}` });
    if (spec.reference) L.push({ text: `REF: ${spec.reference.toUpperCase()}` });
    L.push({ text: `TXID: ${txid(spec)}` });
  } else if (spec.style === 'boleto') {
    L.push({ text: 'BOLETO PAYMENT RECEIPT', bold: true, invert: true }, { text: 'FICTIONAL DEMO BANK - 999' });
    rule();
    if (!spec.omitPayee) L.push({ text: `BENEFICIARY: ${payee}` }, { text: `TAX ID: ${tax}` });
    if (spec.dueOn) L.push({ text: `DUE DATE: ${brDate(spec.dueOn)}` });
    L.push({ text: `PAID ON: ${brDate(spec.paidOn)} ${time}` }, { text: `AMOUNT PAID: ${brMoney(spec.amountCents)}`, bold: true });
    rule();
    L.push({ text: 'DIGITABLE LINE:' }, { text: '99990.00000 00000.000000' }, { text: '00000.000000 9 00000000000000' });
    if (spec.reference) L.push({ text: `REF: ${spec.reference.toUpperCase()}` });
  } else if (spec.style === 'card') {
    L.push({ text: 'CARD SLIP - DEBIT', bold: true, invert: true });
    if (!spec.omitPayee) L.push({ text: `MERCHANT: ${payee}` });
    L.push({ text: `DATE: ${brDate(spec.paidOn)} ${time}` }, { text: 'CARD: DEMO ****0000' });
    rule();
    L.push({ text: `TOTAL: ${brMoney(spec.amountCents)}`, bold: true }, { text: 'APPROVED  AUTH 000000' });
    if (spec.reference) L.push({ text: `REF: ${spec.reference.toUpperCase()}` });
  } else {
    L.push({ text: 'TRANSFER RECEIPT (TED)', bold: true, invert: true }, { text: 'FICTIONAL DEMO BANK - 999' });
    rule();
    L.push({ text: `DATE: ${brDate(spec.paidOn)} ${time}` }, { text: `VALUE: ${brMoney(spec.amountCents)}`, bold: true });
    rule();
    L.push({ text: `FROM: ${payer}` });
    if (!spec.omitPayee) L.push({ text: `PAYEE: ${payee}` }, { text: `TAX ID: ${tax}` });
    L.push({ text: 'BANK 999 BRANCH 0000 ACC 00000-0' });
    if (spec.reference) L.push({ text: `REF: ${spec.reference.toUpperCase()}` });
  }
  rule();
  L.push({ text: 'DEMO DOCUMENT. NOT A REAL RECEIPT.' });
  return L;
}

export function receiptText(spec: ReceiptSpec): string {
  return receiptLines(spec).filter((l) => !l.rule).map((l) => l.text).join('\n');
}

export function renderReceipt(spec: ReceiptSpec, format: 'pdf' | 'png'): Buffer {
  const lines = receiptLines(spec);
  if (format === 'pdf') {
    return buildReceiptPdf(lines as PdfLine[], `${spec.style} receipt ${spec.paidOn}`);
  }
  const r = rasterizeReceipt(lines, { cols: 44, scale: 2, seed: spec.seed ?? spec.amountCents });
  return encodeGrayPng(r.width, r.height, r.pixels, spec.noTextLayer ? {} : { [PNG_TEXT_KEY]: receiptText(spec) });
}
