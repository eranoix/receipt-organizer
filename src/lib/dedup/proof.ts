import { createHash } from 'node:crypto';

export function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface ByteProof {
  identical: boolean;
  sizeA: number;
  sizeB: number;
  bytesCompared: number;
  firstMismatchAt: number | null;
  sha256A: string;
  sha256B: string;
  comparedAt: string;
}

export function proveIdentical(a: Buffer, b: Buffer, now = new Date()): ByteProof {
  const base = { sizeA: a.length, sizeB: b.length, sha256A: sha256(a), sha256B: sha256(b), comparedAt: now.toISOString() };
  const n = Math.min(a.length, b.length);
  const CHUNK = 64 * 1024;
  for (let off = 0; off < n; off += CHUNK) {
    const end = Math.min(off + CHUNK, n);
    if (!a.subarray(off, end).equals(b.subarray(off, end))) {
      let i = off;
      while (i < end && a[i] === b[i]) i += 1;
      return { ...base, identical: false, bytesCompared: i + 1, firstMismatchAt: i };
    }
  }
  if (a.length !== b.length) return { ...base, identical: false, bytesCompared: n, firstMismatchAt: n };
  return { ...base, identical: true, bytesCompared: n, firstMismatchAt: null };
}

export interface HashedFile {
  id: string;
  sha256: string | null;
  firstSeenAt: number;
  settled: boolean;
  name?: string;
}

export function findOriginal(file: HashedFile, others: HashedFile[]): string | null {
  const same = others.filter((o) => o.id !== file.id && o.sha256 && o.sha256 === file.sha256);
  const byAge = (a: HashedFile, b: HashedFile) =>
    a.firstSeenAt - b.firstSeenAt || (a.name ?? '').length - (b.name ?? '').length || a.id.localeCompare(b.id);
  const settled = same.filter((o) => o.settled).sort(byAge);
  if (settled[0]) return settled[0].id;
  const first = [...same, file].sort(byAge)[0];
  return first.id === file.id ? null : first.id;
}
