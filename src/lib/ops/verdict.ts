export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  action?: { label: string; href?: string; post?: string };
}

export interface Verdict { level: 'operational' | 'degraded' | 'outage'; headline: string; counts: Record<CheckStatus, number> }

export function verdict(checks: Check[]): Verdict {
  const counts = { ok: 0, warn: 0, fail: 0 } as Record<CheckStatus, number>;
  for (const c of checks) counts[c.status] += 1;
  const fail = checks.find((c) => c.status === 'fail');
  if (fail) {
    return { level: 'outage', headline: `${fail.label}: ${fail.detail}`, counts };
  }
  const warns = checks.filter((c) => c.status === 'warn');
  if (warns.length) {
    const more = warns.length > 1 ? `, and ${warns.length - 1} more thing(s) to look at` : '';
    return { level: 'degraded', headline: `${warns[0].label}: ${warns[0].detail}${more}`, counts };
  }
  return { level: 'operational', headline: 'Everything is working. Receipts are being read, checked and filed normally.', counts };
}
