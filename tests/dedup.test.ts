import { describe, expect, it } from 'vitest';
import { findOriginal, proveIdentical, sha256 } from '@/lib/dedup/proof';

describe('byte proof', () => {
  it('proves identical buffers identical', () => {
    const a = Buffer.alloc(200_000, 7);
    const p = proveIdentical(a, Buffer.from(a));
    expect(p.identical).toBe(true);
    expect(p.bytesCompared).toBe(200_000);
    expect(p.sha256A).toBe(p.sha256B);
  });

  it('reports the first differing byte, even deep inside a large file', () => {
    const a = Buffer.alloc(150_000, 1);
    const b = Buffer.from(a);
    b[123_456] = 2;
    const p = proveIdentical(a, b);
    expect(p.identical).toBe(false);
    expect(p.firstMismatchAt).toBe(123_456);
  });

  it('treats a prefix as different', () => {
    const p = proveIdentical(Buffer.from('abc'), Buffer.from('abcd'));
    expect(p.identical).toBe(false);
    expect(p.firstMismatchAt).toBe(3);
  });

  it('does not trust a stored hash: same size, different content, different proof', () => {
    const a = Buffer.from('receipt v1');
    const b = Buffer.from('receipt v2');
    expect(a.length).toBe(b.length);
    expect(proveIdentical(a, b).identical).toBe(false);
    expect(sha256(a)).not.toBe(sha256(b));
  });
});

describe('intake gate: findOriginal', () => {
  const h = 'abc';
  it('prefers a settled (filed) file as the original', () => {
    const got = findOriginal(
      { id: 'new', sha256: h, firstSeenAt: 100, settled: false },
      [{ id: 'filed', sha256: h, firstSeenAt: 200, settled: true }, { id: 'other-new', sha256: h, firstSeenAt: 50, settled: false }],
    );
    expect(got).toBe('filed');
  });

  it('is stable for copies arriving in the same batch, whichever is looked at first', () => {
    const a = { id: 'x1', name: 'scan.pdf', sha256: h, firstSeenAt: 100, settled: false };
    const b = { id: 'x0', name: 'scan (1).pdf', sha256: h, firstSeenAt: 100, settled: false };
    expect(findOriginal(a, [b])).toBeNull(); // the shorter name is the original
    expect(findOriginal(b, [a])).toBe('x1');
  });

  it('returns null when nothing shares the hash', () => {
    expect(findOriginal({ id: 'a', sha256: h, firstSeenAt: 1, settled: false }, [{ id: 'b', sha256: 'zzz', firstSeenAt: 0, settled: true }])).toBeNull();
  });
});
