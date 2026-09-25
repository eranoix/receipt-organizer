import { describe, expect, it } from 'vitest';
import { MockExtractor } from '@/lib/extract/mock';
import { parseReceiptText } from '@/lib/extract/parse';
import { assertSafeUrl, BlockedUrlError, hostAllowed, isPrivateAddress } from '@/lib/extract/ssrf';
import { readTextLayer } from '@/lib/extract/text-layer';
import { RateLimitedError, UnreadableError } from '@/lib/extract/types';
import { buildFixtureSet } from '@/lib/fixtures';
import { parseMoneyToCents } from '@/lib/money';
import { renderReceipt, type ReceiptSpec } from '@/lib/render/receipt';

const spec: ReceiptSpec = { style: 'pix', payee: 'Golden Mill Flour', payeeTaxId: '99.999.999/0001-06', amountCents: 184_050, paidOn: '2026-08-05', pixKey: 'orders@golden-mill.example.com', reference: 'flour order' };

describe('text layer round trip', () => {
  it.each(['pdf', 'png'] as const)('reads back the text embedded in a %s', (fmt) => {
    const bytes = renderReceipt(spec, fmt);
    const text = readTextLayer(bytes, fmt === 'pdf' ? 'application/pdf' : 'image/png');
    expect(text).toContain('TO: GOLDEN MILL FLOUR');
    expect(text).toContain('AMOUNT: R$ 1.840,50');
  });

  it('finds no text in a photo without a text layer', () => {
    expect(readTextLayer(renderReceipt({ ...spec, noTextLayer: true }, 'png'), 'image/png')).toBeNull();
  });
});

describe('parseReceiptText', () => {
  it.each([
    ['pix', 'pix'], ['boleto', 'boleto'], ['card', 'card'], ['transfer', 'transfer'],
  ] as const)('parses a %s receipt', (style, method) => {
    const p = parseReceiptText(renderReceipt({ ...spec, style, dueOn: '2026-08-10' }, 'pdf').length ? readTextLayer(renderReceipt({ ...spec, style, dueOn: '2026-08-10' }, 'pdf'), 'application/pdf')! : '');
    expect(p.fields).toMatchObject({ payee: 'Golden Mill Flour', amountCents: 184_050, paymentDate: '2026-08-05', method });
    expect(p.confidence).toBe(1);
  });

  it('uses PAID ON, not the due date, for boletos', () => {
    const p = parseReceiptText('BOLETO PAYMENT RECEIPT\nBENEFICIARY: BLUE RIVER WATER\nDUE DATE: 15/08/2026\nPAID ON: 13/08/2026 09:00\nAMOUNT PAID: R$ 212,40');
    expect(p.fields.paymentDate).toBe('2026-08-13');
  });

  it('does not mistake TOTAL for a TO: payee line', () => {
    const p = parseReceiptText('CARD SLIP\nTOTAL: R$ 10,00\nDATE: 01/02/2026');
    expect(p.fields.payee).toBeNull();
    expect(p.fields.amountCents).toBe(1_000);
  });

  it('lowers confidence when the payee line is missing', () => {
    const p = parseReceiptText(readTextLayer(renderReceipt({ ...spec, omitPayee: true }, 'pdf'), 'application/pdf')!);
    expect(p.fields.payee).toBeNull();
    expect(p.confidence).toBe(0.75);
  });

  it('parses money written either way', () => {
    expect(parseMoneyToCents('R$ 1.234,56')).toBe(123_456);
    expect(parseMoneyToCents('1,234.56')).toBe(123_456);
    expect(parseMoneyToCents('R$ 89,90')).toBe(8_990);
    expect(parseMoneyToCents('4800')).toBe(480_000);
  });
});

describe('MockExtractor', () => {
  it('is deterministic', async () => {
    const x = new MockExtractor();
    const bytes = renderReceipt(spec, 'png');
    const a = await x.extract({ bytes, name: 'a.png', mime: 'image/png' });
    const b = await x.extract({ bytes, name: 'a.png', mime: 'image/png' });
    expect(a).toEqual(b);
  });

  it('reports unreadable documents as permanent', async () => {
    await expect(new MockExtractor().extract({ bytes: renderReceipt({ ...spec, noTextLayer: true }, 'png'), name: 'blurry.png', mime: 'image/png' })).rejects.toBeInstanceOf(UnreadableError);
  });

  it('can simulate a rate limit with a Retry-After', async () => {
    const x = new MockExtractor({ rateLimitEvery: 2, retryAfterMs: 1234 });
    const input = { bytes: renderReceipt(spec, 'pdf'), name: 'a.pdf', mime: 'application/pdf' };
    await x.extract(input);
    const err = await x.extract(input).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterMs).toBe(1234);
  });

  it('reads every generated fixture that has a text layer, correctly', async () => {
    const fx = buildFixtureSet('2026-09-25');
    expect(fx.files.length).toBeGreaterThanOrEqual(38);
    const x = new MockExtractor();
    for (const f of fx.files.filter((f) => f.spec && !f.spec.noTextLayer)) {
      const r = await x.extract({ bytes: f.bytes, name: f.path, mime: f.path.endsWith('.png') ? 'image/png' : 'application/pdf' });
      expect(r.fields.amountCents, f.path).toBe(f.spec!.amountCents);
      expect(r.fields.paymentDate, f.path).toBe(f.spec!.paidOn);
      if (!f.spec!.omitPayee) expect(r.fields.payee?.toLowerCase(), f.path).toBe(f.spec!.payee.toLowerCase());
    }
  });
});

describe('SSRF guard', () => {
  const resolveTo = (...ips: string[]) => async () => ips;

  it('flags private, loopback, link-local and metadata addresses', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.10', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['192.0.2.10', '198.51.100.7', '203.0.113.5']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('matches allowlisted hosts by suffix, so a provider adding a new host is not a full outage', () => {
    expect(hostAllowed('ocr.example.com', ['.example.com'])).toBe(true);
    expect(hostAllowed('files-eu2.example.com', ['.example.com'])).toBe(true);
    expect(hostAllowed('example.com.evil.test', ['.example.com'])).toBe(false);
    expect(hostAllowed('api.example.com', ['api.example.com'])).toBe(true);
  });

  it('accepts an allowlisted https host that resolves to a public address', async () => {
    const u = await assertSafeUrl('https://ocr.example.com/v1/extract', ['.example.com'], resolveTo('203.0.113.5'));
    expect(u.hostname).toBe('ocr.example.com');
  });

  it.each([
    ['http://ocr.example.com/x', 'https'],
    ['https://user:pw@ocr.example.com/x', 'credentials'],
    ['https://203.0.113.5/x', 'IP literals'],
    ['https://ocr.other.test/x', 'allowlist'],
  ])('refuses %s', async (url, why) => {
    await expect(assertSafeUrl(url, ['.example.com'], resolveTo('203.0.113.5'))).rejects.toThrow(why);
  });

  it('refuses an allowlisted name that resolves to a private address (DNS rebinding)', async () => {
    await expect(assertSafeUrl('https://ocr.example.com/x', ['.example.com'], resolveTo('203.0.113.5', '10.0.0.8'))).rejects.toBeInstanceOf(BlockedUrlError);
  });
});
