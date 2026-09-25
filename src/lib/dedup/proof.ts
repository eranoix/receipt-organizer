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

/**
 * Compare two files byte by byte.
 *
 * A matching SHA-256 is an excellent reason to suspect a duplicate and a
 * poor reason to delete one: the stored hash may be stale (the file changed
 * after it was hashed) or belong to a different item after an id mix-up.
 * Deletion is authorised by this proof, taken on freshly read bytes, and
 * nothing else.
 */
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
  /** Already filed, or already taken in from an inbox. Settled files are originals by definition. */
  settled: boolean;
  /** Used only to break ties: "scan.pdf" is the original of "scan (1).pdf". */
  name?: string;
}

/**
 * The intake gate: is this new file a copy of something we already have?
 *
 * A settled file (filed, or taken in earlier) always wins, oldest first. Only
 * when every copy is new, arriving in the same batch, does arrival order
 * decide, with the id as a tie-break so the answer is the same whichever copy
 * is looked at first. Arrival time alone is not enough: a whole batch mirrored
 * in one statement shares one timestamp.
 */
export function findOriginal(file: HashedFile, others: HashedFile[]): string | null {
  const same = others.filter((o) => o.id !== file.id && o.sha256 && o.sha256 === file.sha256);
  const byAge = (a: HashedFile, b: HashedFile) =>
    a.firstSeenAt - b.firstSeenAt || (a.name ?? '').length - (b.name ?? '').length || a.id.localeCompare(b.id);
  const settled = same.filter((o) => o.settled).sort(byAge);
  if (settled[0]) return settled[0].id;
  const first = [...same, file].sort(byAge)[0];
  return first.id === file.id ? null : first.id;
}
