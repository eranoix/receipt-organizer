import { similarity } from '../text';
import { daysBetween } from './recurrence';

export const WINDOW_BEFORE_DAYS = 25;
export const WINDOW_AFTER_DAYS = 15;
export const MIN_SCORE = 0.6;

export interface OpenOccurrence { id: number; billId: number; dueDate: string; expectedCents: number; tolerancePct: number; payee: string }
export interface ReceiptFacts { fileId: string; paymentDate: string | null; amountCents: number | null; payee: string | null }
export interface Match { occurrenceId: number; fileId: string; score: number }

export function scoreMatch(o: OpenOccurrence, r: ReceiptFacts): number | null {
  if (!r.paymentDate || r.amountCents == null) return null;
  const offset = daysBetween(o.dueDate, r.paymentDate);
  if (offset < -WINDOW_BEFORE_DAYS || offset > WINDOW_AFTER_DAYS) return null;

  const allowed = Math.round((o.expectedCents * o.tolerancePct) / 100);
  const diff = Math.abs(r.amountCents - o.expectedCents);
  if (diff > allowed) return null;

  const payeeSim = similarity(o.payee, r.payee);
  if (o.tolerancePct > 0 && payeeSim < 0.5) return null;

  const amountScore = allowed === 0 ? 1 : 1 - diff / (allowed * 2);
  const dateScore = 1 - Math.abs(offset) / (offset < 0 ? WINDOW_BEFORE_DAYS : WINDOW_AFTER_DAYS) / 2;
  return Math.round((0.5 * amountScore + 0.25 * dateScore + 0.25 * payeeSim) * 100) / 100;
}

export function matchReceipts(occurrences: OpenOccurrence[], receipts: ReceiptFacts[], minScore = MIN_SCORE): Match[] {
  const pairs: Match[] = [];
  for (const o of occurrences) {
    for (const r of receipts) {
      const score = scoreMatch(o, r);
      if (score !== null && score >= minScore) pairs.push({ occurrenceId: o.id, fileId: r.fileId, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.occurrenceId - b.occurrenceId || a.fileId.localeCompare(b.fileId));
  const usedO = new Set<number>();
  const usedR = new Set<string>();
  const out: Match[] = [];
  for (const p of pairs) {
    if (usedO.has(p.occurrenceId) || usedR.has(p.fileId)) continue;
    usedO.add(p.occurrenceId);
    usedR.add(p.fileId);
    out.push(p);
  }
  return out;
}
