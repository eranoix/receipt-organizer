'use client';

import Link from 'next/link';
import { useState } from 'react';
import { apiSend, fmtAgo, useApi } from '../client';
import { IconAlert, IconCheck, IconGauge } from '../icons';
import { useToast } from '../toast';
import { Spinner } from '../ui';

interface Check { id: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string; action?: { label: string; href?: string; post?: string } }
interface StatusData { level: 'operational' | 'degraded' | 'outage'; headline: string; counts: Record<string, number>; checks: Check[]; checkedAt: string }

const BANNER = {
  operational: 'border-ok/30 bg-ok/10 text-ok',
  degraded: 'border-warn/30 bg-warn/10 text-warn',
  outage: 'border-bad/30 bg-bad/10 text-bad',
};
const TITLE = { operational: 'All systems normal', degraded: 'Working, with something to look at', outage: 'Something needs attention now' };

export function Status() {
  const { data, reload } = useApi<StatusData>('/api/status', 5_000);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  if (!data) return <div className="flex justify-center py-20 text-muted"><Spinner size={20} /></div>;

  const post = async (c: Check) => {
    setBusy(c.id);
    try {
      await apiSend('POST', c.action!.post!);
      toast({ tone: 'ok', title: `${c.action!.label}: queued`, body: 'This page refreshes as soon as it lands.' });
      setTimeout(() => void reload(true), 2500);
    } catch (e) {
      toast({ tone: 'bad', title: 'Could not do that', body: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const order = { fail: 0, warn: 1, ok: 2 };
  const checks = [...data.checks].sort((a, b) => order[a.status] - order[b.status]);

  return (
    <>
      <div className={`mb-5 rounded-xl border p-5 ${BANNER[data.level]}`}>
        <div className="flex items-center gap-3">
          {data.level === 'operational' ? <IconCheck size={26} /> : <IconAlert size={26} />}
          <div>
            <h1 className="text-lg font-semibold">{TITLE[data.level]}</h1>
            <p className="text-sm opacity-90">{data.headline}</p>
          </div>
        </div>
        <div className="mt-3 text-xs opacity-80">{data.counts.ok} fine, {data.counts.warn} to look at, {data.counts.fail} failing · checked {fmtAgo(data.checkedAt)}</div>
      </div>

      <div className="card divide-y divide-line">
        {checks.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${c.status === 'ok' ? 'bg-ok' : c.status === 'warn' ? 'bg-warn' : 'bg-bad'}`} aria-label={c.status} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{c.label}</div>
              <div className="text-xs text-muted">{c.detail}</div>
            </div>
            {c.action?.href && <Link href={c.action.href} className="btn btn-sm">{c.action.label}</Link>}
            {c.action?.post && <button className="btn btn-sm" disabled={busy === c.id} onClick={() => post(c)}>{busy === c.id ? <Spinner size={11} /> : null}{c.action.label}</button>}
          </div>
        ))}
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted"><IconGauge size={13} />Health and connections on one page. The dot in the sidebar follows the same verdict.</p>
    </>
  );
}
