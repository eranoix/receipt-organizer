/** Lowercase, strip accents and punctuation: the key payees are compared by. */
export function normalizeKey(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(co|inc|ltd|ltda|llc|sa|s a|me|eireli)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Token-set similarity in [0, 1]. Good enough for "Aurora Power Co." vs "AURORA POWER". */
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = new Set(normalizeKey(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeKey(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.max(ta.size, tb.size);
}

export function slug(s: string): string {
  return normalizeKey(s).replace(/ /g, '-').slice(0, 40) || 'file';
}
