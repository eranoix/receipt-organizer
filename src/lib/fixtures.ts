/**
 * The invented business behind the demo: Juniper Lane Bakery, a small
 * bakery with a landlord, three utilities, a city tax and a few suppliers.
 * Every name, tax id, key and account here is made up; tax ids are all
 * nines (invalid by construction) and the bank is "999".
 *
 * Dates are relative to "today" so the demo always looks current: receipts
 * paid in the last four weeks sit in the inboxes waiting to be filed, older
 * ones are already filed, and upcoming bills are still open.
 */

import { addDays, dueDatesBetween } from './bills/recurrence';
import { renderReceipt, type ReceiptSpec, type ReceiptStyle } from './render/receipt';
import { slug } from './text';

export const FOLDERS = [
  'Inbox', 'Phone scans',
  'Utilities', 'Utilities/Electricity', 'Utilities/Water', 'Utilities/Internet',
  'Rent',
  'Suppliers', 'Suppliers/Flour and grains', 'Suppliers/Dairy', 'Suppliers/Packaging',
  'Taxes', 'Equipment', 'Archive',
] as const;

export const INBOXES = [
  { path: 'Inbox', label: 'Inbox', primary: true },
  { path: 'Phone scans', label: 'Phone scans', primary: false },
];

export const FOLDER_RULES: { pattern: string; path: string }[] = [
  { pattern: 'power|energy|electric', path: 'Utilities/Electricity' },
  { pattern: 'water', path: 'Utilities/Water' },
  { pattern: 'fiber|internet', path: 'Utilities/Internet' },
  { pattern: 'properties|rent', path: 'Rent' },
  { pattern: 'tax office', path: 'Taxes' },
  { pattern: 'oven|repair|equipment', path: 'Equipment' },
  { pattern: 'flour|mill|grain', path: 'Suppliers/Flour and grains' },
  { pattern: 'dairy|milk', path: 'Suppliers/Dairy' },
  { pattern: 'packaging|boxes', path: 'Suppliers/Packaging' },
];

export interface BillDef {
  key: string; name: string; payee: string; taxId: string; amountCents: number; tolerancePct: number;
  dueDay: number; method: 'pix' | 'boleto' | 'transfer'; folder: string; format: 'pdf' | 'png'; pixKey?: string;
}

export const BILLS: BillDef[] = [
  { key: 'power', name: 'Electricity', payee: 'Aurora Power Co.', taxId: '99.999.999/0001-01', amountCents: 69_000, tolerancePct: 35, dueDay: 10, method: 'boleto', folder: 'Utilities/Electricity', format: 'pdf' },
  { key: 'water', name: 'Water', payee: 'Blue River Water', taxId: '99.999.999/0001-02', amountCents: 21_000, tolerancePct: 30, dueDay: 15, method: 'boleto', folder: 'Utilities/Water', format: 'pdf' },
  { key: 'internet', name: 'Internet', payee: 'Northwind Fiber', taxId: '99.999.999/0001-03', amountCents: 19_990, tolerancePct: 0, dueDay: 5, method: 'pix', folder: 'Utilities/Internet', format: 'png', pixKey: 'billing@northwind-fiber.example.com' },
  { key: 'rent', name: 'Shop rent', payee: 'Maple Street Properties', taxId: '99.999.999/0001-04', amountCents: 480_000, tolerancePct: 0, dueDay: 1, method: 'transfer', folder: 'Rent', format: 'pdf' },
  { key: 'tax', name: 'City business tax', payee: 'Riverton City Tax Office', taxId: '99.999.999/0001-05', amountCents: 124_055, tolerancePct: 0, dueDay: 20, method: 'boleto', folder: 'Taxes', format: 'pdf' },
];

/** Bill occurrences the seed pays through the payments center instead of a dropped receipt. */
export const PAID_VIA_PAYMENTS_CENTER = 'internet';
/** Left unpaid on purpose, so the bills screen has something overdue to act on. */
export const LEFT_UNPAID = 'water';

export interface FixtureFile {
  path: string;
  bytes: Buffer;
  spec: ReceiptSpec | null;
  /** Why this file exists in the demo. */
  role: 'filed' | 'inbox' | 'duplicate' | 'collision' | 'unreadable' | 'torn' | 'mangled';
  duplicateOf?: string;
}

export interface FixtureSet {
  today: string;
  files: FixtureFile[];
  /** The latest occurrence of the bill paid via the payments center. */
  paymentsCenterDue: string | null;
}

function variableAmount(base: number, tolerancePct: number, i: number): number {
  if (tolerancePct === 0) return base;
  const swing = [0.06, -0.09, 0.14, -0.03, 0.1, -0.12][i % 6];
  return Math.round(base * (1 + swing));
}

function monthStart(iso: string, monthsBack: number): string {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - monthsBack, 1));
  return d.toISOString().slice(0, 10);
}

export function buildFixtureSet(today = new Date().toISOString().slice(0, 10)): FixtureSet {
  const files: FixtureFile[] = [];
  const add = (folder: string, name: string, spec: ReceiptSpec, format: 'pdf' | 'png', role: FixtureFile['role']) => {
    const f: FixtureFile = { path: `${folder}/${name}`, bytes: renderReceipt(spec, format), spec, role };
    files.push(f);
    return f;
  };
  let seq = 4100;
  let paymentsCenterDue: string | null = null;

  // Recurring bills: one receipt per past occurrence, paid two days early.
  for (const b of BILLS) {
    const dues = dueDatesBetween({ dueDay: b.dueDay, startsOn: monthStart(today, 4) }, monthStart(today, 3), addDays(today, 45));
    dues.forEach((due, i) => {
      const paidOn = addDays(due, -2);
      if (paidOn >= today) return; // upcoming: still open
      const recent = addDays(today, -28) < paidOn;
      if (recent && b.key === PAID_VIA_PAYMENTS_CENTER) { paymentsCenterDue = due; return; }
      if (recent && b.key === LEFT_UNPAID) return;
      const style: ReceiptStyle = b.method;
      const spec: ReceiptSpec = {
        style, payee: b.payee, payeeTaxId: b.taxId, amountCents: variableAmount(b.amountCents, b.tolerancePct, i), paidOn, dueOn: style === 'boleto' ? due : undefined,
        time: `0${8 + (i % 2)}:${10 + i * 7}`, pixKey: b.pixKey, reference: `${b.name} ${due.slice(0, 7)}`, seed: i + b.dueDay,
      };
      const name = b.format === 'png' ? `receipt_${slug(b.payee)}_${paidOn.slice(5).replace('-', '')}.png` : `${style}_${paidOn}_${slug(b.payee)}.pdf`;
      add(recent ? 'Inbox' : b.folder, name, spec, b.format, recent ? 'inbox' : 'filed');
    });
  }
  // If the payments-center bill had no recent past occurrence, pay the next one.
  if (!paymentsCenterDue) {
    const b = BILLS.find((x) => x.key === PAID_VIA_PAYMENTS_CENTER)!;
    paymentsCenterDue = dueDatesBetween({ dueDay: b.dueDay, startsOn: monthStart(today, 4) }, today, addDays(today, 45))[0] ?? null;
  }

  const d = (n: number) => addDays(today, -n);
  const sup = (folder: string, payee: string, taxId: string, style: ReceiptStyle, format: 'pdf' | 'png', days: number, cents: number, role: FixtureFile['role'], name?: string, extra: Partial<ReceiptSpec> = {}) =>
    add(folder, name ?? (format === 'png' ? `IMG_${seq++}.png` : `${style}_${d(days)}_${slug(payee)}.pdf`),
      { style, payee, payeeTaxId: taxId, amountCents: cents, paidOn: d(days), time: `1${days % 10}:0${days % 6}`, seed: days, ...extra }, format, role);

  const golden = ['Golden Mill Flour', '99.999.999/0001-06'] as const;
  const harbor = ['Harbor Dairy Co-op', '99.999.999/0001-07'] as const;
  const boxwell = ['Boxwell Packaging', '99.999.999/0001-08'] as const;

  sup('Suppliers/Flour and grains', ...golden, 'pix', 'png', 95, 184_050, 'filed', undefined, { pixKey: 'orders@golden-mill.example.com' });
  sup('Suppliers/Flour and grains', ...golden, 'pix', 'pdf', 65, 171_300, 'filed', undefined, { pixKey: 'orders@golden-mill.example.com' });
  sup('Suppliers/Flour and grains', ...golden, 'pix', 'pdf', 40, 192_475, 'filed', undefined, { pixKey: 'orders@golden-mill.example.com' });
  const harborFiled = sup('Suppliers/Dairy', ...harbor, 'card', 'png', 70, 35_680, 'filed', 'card_harbor-dairy.png');
  sup('Suppliers/Dairy', ...harbor, 'pix', 'pdf', 38, 41_220, 'filed', 'harbor-dairy-invoice.pdf');
  sup('Suppliers/Dairy', ...harbor, 'card', 'pdf', 55, 29_990, 'filed');
  const boxFiled = sup('Suppliers/Packaging', ...boxwell, 'card', 'pdf', 50, 62_800, 'filed');
  sup('Suppliers/Packaging', ...boxwell, 'card', 'pdf', 85, 58_140, 'filed');
  sup('Equipment', 'Oven Parts Depot', '99.999.999/0001-09', 'card', 'pdf', 80, 97_500, 'filed');
  sup('Archive', ...golden, 'pix', 'pdf', 300, 150_000, 'filed');

  sup('Inbox', ...golden, 'pix', 'png', 5, 188_920, 'inbox', undefined, { pixKey: 'orders@golden-mill.example.com' });
  sup('Inbox', ...harbor, 'pix', 'pdf', 3, 38_760, 'collision', 'harbor-dairy-invoice.pdf');
  sup('Inbox', ...boxwell, 'card', 'pdf', 9, 64_310, 'mangled');
  sup('Inbox', 'Kettle & Oven Repairs', '99.999.999/0001-10', 'card', 'png', 6, 42_000, 'inbox');
  sup('Inbox', 'Sunrise Market', '99.999.999/0001-11', 'card', 'pdf', 4, 8_935, 'inbox');
  sup('Inbox', ...harbor, 'pix', 'png', 7, 27_450, 'torn', undefined, { omitPayee: true });
  sup('Inbox', 'Unknown', '', 'card', 'png', 1, 1_000, 'unreadable', 'IMG_blurry_counter_photo.png', { noTextLayer: true });
  sup('Phone scans', ...harbor, 'card', 'png', 12, 31_540, 'inbox');
  sup('Phone scans', 'Sunrise Market', '99.999.999/0001-11', 'card', 'png', 2, 5_620, 'inbox');
  sup('Phone scans', ...golden, 'pix', 'png', 16, 96_000, 'inbox', undefined, { pixKey: 'orders@golden-mill.example.com' });

  // Exact copies: the same bytes arriving again under another name.
  const copy = (of: FixtureFile, folder: string, name: string) =>
    files.push({ path: `${folder}/${name}`, bytes: Buffer.from(of.bytes), spec: of.spec, role: 'duplicate', duplicateOf: of.path });
  const power = files.find((f) => f.role === 'filed' && f.path.startsWith('Utilities/Electricity'));
  if (power) copy(power, 'Inbox', power.path.split('/').pop()!.replace('.pdf', ' (copy).pdf'));
  copy(harborFiled, 'Phone scans', `IMG_${seq++}.png`);
  copy(boxFiled, 'Inbox', 'boxwell-order-copy.pdf');
  const inboxPng = files.find((f) => f.role === 'inbox' && f.path.startsWith('Inbox/IMG_'));
  if (inboxPng) copy(inboxPng, 'Inbox', inboxPng.path.split('/').pop()!.replace('.png', ' (1).png'));

  return { today, files, paymentsCenterDue };
}
