import { describe, expect, it } from 'vitest';
import { verdict } from '@/lib/ops/verdict';
import { pixKeyKind, validatePayment } from '@/lib/payments/validation';
import { MockPaymentProvider } from '@/lib/payments/provider';
import { RateLimiter } from '@/lib/rate-limit';
import { crc32 } from '@/lib/render/crc32';
import { buildZip } from '@/lib/render/zip';
import { pathInScope } from '@/lib/scope';

describe('zip', () => {
  it('writes a valid stored archive with UTF-8 names and de-duplicated entries', () => {
    const z = buildZip([{ name: 'Rent/a.pdf', data: Buffer.from('aaa') }, { name: 'Rent/a.pdf', data: Buffer.from('bbb') }, { name: 'Zürich-Straße.png', data: Buffer.from('c') }]);
    expect(z.readUInt32LE(0)).toBe(0x04034b50);
    const end = z.length - 22;
    expect(z.readUInt32LE(end)).toBe(0x06054b50);
    expect(z.readUInt16LE(end + 10)).toBe(3);
    const text = z.toString('utf8');
    expect(text).toContain('Rent/a (2).pdf');
    expect(text).toContain('Zürich-Straße.png');
    expect(z.readUInt32LE(14)).toBe(crc32(Buffer.from('aaa')));
  });

  it('strips path traversal from names', () => {
    expect(buildZip([{ name: '../../etc/passwd', data: Buffer.from('x') }]).toString('latin1')).not.toContain('..');
  });

  it('crc32 matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('payment validation', () => {
  const base = { payee: 'Northwind Fiber', amountCents: 19_990, idempotencyKey: 'pay-12345678' };

  it('recognises every kind of Pix key', () => {
    expect(pixKeyKind('billing@northwind-fiber.example.com')).toBe('email');
    expect(pixKeyKind('+5511999999999')).toBe('phone');
    expect(pixKeyKind('99.999.999/0001-99')).toBe('tax_id');
    expect(pixKeyKind('123e4567-e89b-42d3-a456-426614174000')).toBe('random');
    expect(pixKeyKind('not a key')).toBeNull();
  });

  it('validates transfers with a 3-digit COMPE bank code', () => {
    expect(validatePayment({ ...base, method: 'transfer', bankCode: '999', branch: '0000', account: '12345-6' }).ok).toBe(true);
    const bad = validatePayment({ ...base, method: 'transfer', bankCode: '99999999', branch: '0000', account: '12345-6' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.bankCode).toBeDefined();
  });

  it('validates boleto digitable lines by length', () => {
    expect(validatePayment({ ...base, method: 'boleto', boletoLine: '9'.repeat(47) }).ok).toBe(true);
    expect(validatePayment({ ...base, method: 'boleto', boletoLine: '9'.repeat(40) }).ok).toBe(false);
  });

  it('rejects zero, negative and absurd amounts, and a missing request id', () => {
    for (const amountCents of [0, -5, 1.5, 200_000_000]) expect(validatePayment({ ...base, amountCents, method: 'pix', pixKey: 'a@example.com' }).ok).toBe(false);
    expect(validatePayment({ ...base, idempotencyKey: '', method: 'pix', pixKey: 'a@example.com' }).ok).toBe(false);
  });
});

describe('mock payment provider', () => {
  it('is idempotent, settles after a delay and returns a readable receipt', async () => {
    let t = 0;
    const p = new MockPaymentProvider(1_000, () => t);
    const req = { idempotencyKey: 'k-1', method: 'pix' as const, payee: 'Northwind Fiber', amountCents: 19_990, details: { pixKey: 'a@example.com' } };
    const a = await p.send(req);
    expect((await p.send(req)).ref).toBe(a.ref);
    expect((await p.status(a.ref, req, 0)).state).toBe('processing');
    t = 1_500;
    const s = await p.status(a.ref, req, 0);
    expect(s.state).toBe('paid');
    if (s.state === 'paid') expect(s.receipt.bytes.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('declines permanently on the demo rule', async () => {
    await expect(new MockPaymentProvider().send({ idempotencyKey: 'k', method: 'pix', payee: 'DECLINE me', amountCents: 1, details: {} })).rejects.toMatchObject({ code: 'declined' });
  });
});

describe('rate limiter', () => {
  it('allows the limit per window, then says when to retry', () => {
    let t = 0;
    const rl = new RateLimiter(3, 1_000, () => t);
    expect([rl.hit('a').ok, rl.hit('a').ok, rl.hit('a').ok, rl.hit('a').ok]).toEqual([true, true, true, false]);
    expect(rl.hit('b').ok).toBe(true);
    t = 400;
    expect(rl.hit('a').retryAfterMs).toBe(600);
    t = 1_001;
    expect(rl.hit('a').ok).toBe(true);
  });
});

describe('scope', () => {
  it('gives a folder and everything below it, and nothing that merely shares a prefix', () => {
    expect(pathInScope('/Suppliers/Dairy/a.pdf', ['/Suppliers'])).toBe(true);
    expect(pathInScope('/Suppliers', ['/Suppliers'])).toBe(true);
    expect(pathInScope('/SuppliersOld/a.pdf', ['/Suppliers'])).toBe(false);
    expect(pathInScope('/Rent/a.pdf', [])).toBe(false);
    expect(pathInScope('/anything', ['/'])).toBe(true);
  });
});

describe('status verdict', () => {
  it('leads with the worst check, in words', () => {
    expect(verdict([{ id: 'a', label: 'Database', status: 'ok', detail: 'fine' }]).level).toBe('operational');
    const d = verdict([{ id: 'a', label: 'DLQ', status: 'warn', detail: '2 need a decision' }, { id: 'b', label: 'Sync', status: 'warn', detail: 'slow' }]);
    expect(d.level).toBe('degraded');
    expect(d.headline).toBe('DLQ: 2 need a decision, and 1 more thing(s) to look at');
    const o = verdict([{ id: 'a', label: 'DLQ', status: 'warn', detail: 'x' }, { id: 'w', label: 'Background worker', status: 'fail', detail: 'silent' }]);
    expect(o.level).toBe('outage');
    expect(o.headline).toBe('Background worker: silent');
  });
});
