import { describe, expect, it } from 'vitest';
import { certainty, suggestFolder, SUGGEST_THRESHOLD, type HistoryRow } from '@/lib/classify/classifier';

const history: HistoryRow[] = [
  { payeeKey: 'aurora power', taxId: '99.999.999/0001-01', folderId: 'power', count: 3 },
  { payeeKey: 'harbor dairy', taxId: '99.999.999/0001-07', folderId: 'dairy', count: 2 },
  { payeeKey: 'harbor dairy', taxId: '99.999.999/0001-07', folderId: 'archive', count: 1 },
];
const rules = [{ pattern: 'oven|repair', folderId: 'equipment' }, { pattern: 'dairy|milk', folderId: 'dairy' }];

describe('suggestFolder', () => {
  it('is confident when the tax id was always filed in the same place', () => {
    const s = suggestFolder({ payee: 'Aurora Power Co.', payeeTaxId: '99.999.999/0001-01', reference: null }, history, rules);
    expect(s.folderId).toBe('power');
    expect(s.confidence).toBeGreaterThanOrEqual(SUGGEST_THRESHOLD);
    expect(s.reasons.join(' ')).toMatch(/3 of 3/);
  });

  it('matches payees despite punctuation, case and company suffixes', () => {
    const s = suggestFolder({ payee: 'AURORA POWER', payeeTaxId: null, reference: null }, history, rules);
    expect(s.folderId).toBe('power');
  });

  it('splits confidence when history disagrees, and offers the alternative', () => {
    const s = suggestFolder({ payee: 'Harbor Dairy', payeeTaxId: null, reference: null }, [history[1], history[2]], []);
    expect(s.folderId).toBe('dairy');
    expect(s.confidence).toBeLessThan(SUGGEST_THRESHOLD);
    expect(s.alternatives.map((a) => a.folderId)).toContain('archive');
  });

  it('a keyword rule alone stays below the threshold: a person must decide', () => {
    const s = suggestFolder({ payee: 'Kettle & Oven Repairs', payeeTaxId: null, reference: null }, history, rules);
    expect(s.folderId).toBe('equipment');
    expect(s.confidence).toBe(0.7);
    expect(s.confidence).toBeLessThan(SUGGEST_THRESHOLD);
  });

  it('independent signals for the same folder reinforce each other', () => {
    const alone = suggestFolder({ payee: 'Harbor Dairy', payeeTaxId: null, reference: null }, [history[1]], []);
    const both = suggestFolder({ payee: 'Harbor Dairy', payeeTaxId: null, reference: null }, [history[1]], rules);
    expect(both.confidence).toBeGreaterThan(alone.confidence);
    expect(both.confidence).toBeLessThanOrEqual(0.99);
  });

  it('returns no folder, with a reason, for an unknown payee', () => {
    const s = suggestFolder({ payee: 'Sunrise Market', payeeTaxId: null, reference: null }, history, rules);
    expect(s.folderId).toBeNull();
    expect(s.reasons[0]).toMatch(/no earlier receipts/);
    expect(suggestFolder({ payee: null, payeeTaxId: null, reference: null }, history, []).reasons[0]).toMatch(/could not be read/);
  });

  it('never suggests a folder outside the valid set (deleted, inbox, out of scope)', () => {
    const s = suggestFolder({ payee: 'Aurora Power', payeeTaxId: null, reference: null }, history, rules, new Set(['dairy']));
    expect(s.folderId).toBeNull();
  });

  it('certainty grows with evidence', () => {
    expect(certainty(1)).toBe(0.75);
    expect(certainty(3)).toBeGreaterThan(0.9);
  });
});
