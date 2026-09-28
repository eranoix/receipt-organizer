import { normalizeKey, similarity } from '../text';

export const SUGGEST_THRESHOLD = 0.8;

export interface HistoryRow { payeeKey: string; taxId: string | null; folderId: string; count: number }
export interface FolderRule { pattern: string; folderId: string }
export interface ReceiptForClassify { payee: string | null; payeeTaxId: string | null; reference: string | null; rawText?: string | null }
export interface Candidate { folderId: string; confidence: number; reasons: string[] }
export interface Suggestion { folderId: string | null; confidence: number; reasons: string[]; alternatives: Candidate[] }

export function certainty(n: number): number {
  return 1 - 0.5 ** (n + 1);
}

export function suggestFolder(r: ReceiptForClassify, history: HistoryRow[], rules: FolderRule[], validFolders?: Set<string>): Suggestion {
  const signals = new Map<string, { scores: number[]; reasons: string[] }>();
  const add = (folderId: string, score: number, reason: string) => {
    if (validFolders && !validFolders.has(folderId)) return;
    const s = signals.get(folderId) ?? { scores: [], reasons: [] };
    s.scores.push(score);
    s.reasons.push(reason);
    signals.set(folderId, s);
  };

  const tax = r.payeeTaxId?.replace(/\D/g, '') || null;
  if (tax) {
    const rows = history.filter((h) => h.taxId && h.taxId.replace(/\D/g, '') === tax);
    const total = rows.reduce((a, h) => a + h.count, 0);
    for (const h of rows) {
      add(h.folderId, (h.count / total) * certainty(total), `${h.count} of ${total} earlier receipts with this tax id were filed here`);
    }
  }

  const key = normalizeKey(r.payee);
  if (key) {
    const rows = history.filter((h) => h.payeeKey === key || similarity(h.payeeKey, key) >= 0.8);
    const total = rows.reduce((a, h) => a + h.count, 0);
    const byFolder = new Map<string, number>();
    for (const h of rows) byFolder.set(h.folderId, (byFolder.get(h.folderId) ?? 0) + h.count);
    for (const [folderId, count] of byFolder) {
      add(folderId, 0.95 * (count / total) * certainty(total), `${count} of ${total} earlier receipts from ${r.payee} were filed here`);
    }
  }

  const haystack = `${r.payee ?? ''} ${r.reference ?? ''} ${r.rawText ?? ''}`.toLowerCase();
  for (const rule of rules) {
    const words = rule.pattern.toLowerCase().split('|').map((w) => w.trim()).filter(Boolean);
    const hit = words.find((w) => haystack.includes(w));
    if (hit) add(rule.folderId, 0.7, `mentions "${hit}" (folder rule)`);
  }

  const ranked: Candidate[] = [...signals.entries()]
    .map(([folderId, s]) => ({
      folderId,
      confidence: Math.min(0.99, 1 - s.scores.reduce((p, x) => p * (1 - x), 1)),
      reasons: s.reasons,
    }))
    .map((c) => ({ ...c, confidence: Math.round(c.confidence * 100) / 100 }))
    .sort((a, b) => b.confidence - a.confidence || a.folderId.localeCompare(b.folderId));

  const best = ranked[0];
  if (!best) {
    return {
      folderId: null,
      confidence: 0,
      reasons: [r.payee ? `no earlier receipts from ${r.payee} and no folder rule matched` : 'payee could not be read'],
      alternatives: [],
    };
  }
  return { folderId: best.folderId, confidence: best.confidence, reasons: best.reasons, alternatives: ranked.slice(1, 4) };
}
