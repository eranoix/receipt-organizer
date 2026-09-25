import { describe, expect, it } from 'vitest';
import { matchReceipts, scoreMatch, type OpenOccurrence } from '@/lib/bills/matching';
import { addDays, dueDatesBetween } from '@/lib/bills/recurrence';

const rent: OpenOccurrence = { id: 1, billId: 1, dueDate: '2026-09-01', expectedCents: 480_000, tolerancePct: 0, payee: 'Maple Street Properties' };
const power: OpenOccurrence = { id: 2, billId: 2, dueDate: '2026-09-10', expectedCents: 69_000, tolerancePct: 35, payee: 'Aurora Power Co.' };

describe('scoreMatch', () => {
  it('needs both a payment date and an amount', () => {
    expect(scoreMatch(rent, { fileId: 'f', paymentDate: null, amountCents: 480_000, payee: 'Maple Street Properties' })).toBeNull();
    expect(scoreMatch(rent, { fileId: 'f', paymentDate: '2026-08-30', amountCents: null, payee: 'Maple Street Properties' })).toBeNull();
  });

  it('matches a fixed bill on the exact amount even with a mangled payee', () => {
    const s = scoreMatch(rent, { fileId: 'f', paymentDate: '2026-08-30', amountCents: 480_000, payee: 'MAPLE ST PROP' });
    expect(s).not.toBeNull();
  });

  it('refuses a fixed bill paid with a different amount', () => {
    expect(scoreMatch(rent, { fileId: 'f', paymentDate: '2026-08-30', amountCents: 480_001, payee: 'Maple Street Properties' })).toBeNull();
  });

  it('allows a variable bill within its tolerance but requires the payee to look alike', () => {
    expect(scoreMatch(power, { fileId: 'f', paymentDate: '2026-09-08', amountCents: 80_000, payee: 'Aurora Power' })).toBeGreaterThan(0.6);
    expect(scoreMatch(power, { fileId: 'f', paymentDate: '2026-09-08', amountCents: 80_000, payee: 'Golden Mill Flour' })).toBeNull();
    expect(scoreMatch(power, { fileId: 'f', paymentDate: '2026-09-08', amountCents: 99_000, payee: 'Aurora Power' })).toBeNull();
  });

  it('only looks inside the window around the due date', () => {
    expect(scoreMatch(rent, { fileId: 'f', paymentDate: '2026-07-20', amountCents: 480_000, payee: 'Maple Street Properties' })).toBeNull();
    expect(scoreMatch(rent, { fileId: 'f', paymentDate: '2026-09-20', amountCents: 480_000, payee: 'Maple Street Properties' })).toBeNull();
  });
});

describe('matchReceipts', () => {
  it('assigns one receipt per occurrence, best pairs first', () => {
    const aug = { ...rent, id: 3, dueDate: '2026-08-01' };
    const m = matchReceipts([rent, aug], [
      { fileId: 'aug', paymentDate: '2026-07-30', amountCents: 480_000, payee: 'Maple Street Properties' },
      { fileId: 'sep', paymentDate: '2026-08-30', amountCents: 480_000, payee: 'Maple Street Properties' },
    ]);
    expect(m).toHaveLength(2);
    expect(m.find((x) => x.occurrenceId === 1)?.fileId).toBe('sep');
    expect(m.find((x) => x.occurrenceId === 3)?.fileId).toBe('aug');
  });

  it('does not use the same receipt twice', () => {
    const m = matchReceipts([rent, { ...rent, id: 9 }], [{ fileId: 'only', paymentDate: '2026-08-30', amountCents: 480_000, payee: 'Maple Street Properties' }]);
    expect(m).toHaveLength(1);
  });
});

describe('recurrence', () => {
  it('lists monthly due dates across a year boundary, from the start date on', () => {
    expect(dueDatesBetween({ dueDay: 10, startsOn: '2026-11-15' }, '2026-10-01', '2027-02-28')).toEqual(['2026-12-10', '2027-01-10', '2027-02-10']);
  });
  it('adds days in UTC', () => {
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
  });
});
