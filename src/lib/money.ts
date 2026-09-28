const brl = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'BRL' });

export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '-';
  return brl.format(cents / 100);
}

export function parseMoneyToCents(input: string): number | null {
  const s = input.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  const m = s.match(/^(-?[\d.,]*?)[.,](\d{2})$/);
  const whole = (m ? m[1] : s).replace(/[.,]/g, '');
  const frac = m ? m[2] : '00';
  const n = Number(`${whole || '0'}.${frac}`);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
