'use client';

import Link from 'next/link';
import { apiSend, fmtAgo, fmtDate, fmtMoney, useApi } from '../client';
import { IconArrowRight, IconInbox, IconRefresh } from '../icons';
import { useToast } from '../toast';
import { Badge, PageHeader, Spinner, Stat } from '../ui';

interface Data {
  stages: Record<string, number>;
  dead: number;
  inflight: number;
  bills: { id: number; due_date: string; expected_cents: number; name: string; payee: string }[];
  month: { paid: number; paid_cents: number; open: number };
  filedWeek: number;
  activity: { uid: string; source: string; level: string; message: string; created_at: string; state: string; actor: string | null }[];
  inboxes: { folder_id: string; label: string; waiting: number }[];
  sync: { last_delta_at: string | null; last_full_at: string | null; lock_owner: string | null; last_error: string | null } | null;
}

const SOURCE_TONE: Record<string, 'accent' | 'muted' | 'warn' | 'ok'> = { audit: 'muted', sync: 'accent', ocr: 'accent', dedup: 'warn', queue: 'warn', payment: 'ok', system: 'muted' };

export function Dashboard({ firstName }: { firstName: string }) {
  const { data, reload } = useApi<Data>('/api/dashboard', 10_000);
  const toast = useToast();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  if (!data) return <div className="flex justify-center py-20 text-muted"><Spinner size={20} /></div>;
  const waiting = (data.stages.suggested ?? 0) + (data.stages.needs_decision ?? 0) + (data.stages.unreadable ?? 0);
  const today = new Date().toISOString().slice(0, 10);

  const reconcile = async () => {
    try {
      await apiSend('POST', '/api/sync');
      toast({ tone: 'ok', title: 'Full reconciliation requested', body: 'The worker compares the whole drive with the mirror on its next pass.' });
      setTimeout(() => void reload(true), 3000);
    } catch (e) {
      toast({ tone: 'bad', title: 'Could not request a sync', body: (e as Error).message });
    }
  };

  return (
    <>
      <PageHeader title={`${greeting}, ${firstName}`} subtitle="What needs you today. Nothing is filed, deleted or paid without a person saying so." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Waiting for review" value={waiting} hint={`${data.stages.reading ?? 0} still being read`} href="/review" />
        <Stat label="Ready to confirm" value={data.stages.suggested ?? 0} hint="Suggestion at 80% or more" tone={data.stages.suggested ? 'ok' : undefined} href="/review?stage=suggested" />
        <Stat label="Possible duplicates" value={data.stages.duplicate ?? 0} hint="Held out of review" tone={data.stages.duplicate ? 'warn' : undefined} href="/duplicates" />
        <Stat label="Needs a decision" value={data.dead} hint="Operations that failed for good" tone={data.dead ? 'bad' : undefined} href="/operations?state=open&source=queue" />
        <Stat label="Bills this month" value={`${data.month.paid} / ${data.month.paid + data.month.open}`} hint={`${fmtMoney(data.month.paid_cents)} matched to receipts`} href="/bills" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Inboxes</h2>
            <span className="text-xs text-muted">{data.filedWeek} filed this week</span>
          </div>
          <ul className="space-y-2">
            {data.inboxes.map((i) => (
              <li key={i.folder_id}>
                <Link href={`/review?inbox=${i.folder_id}`} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5 hover:border-accent/50">
                  <IconInbox size={18} className="text-muted" />
                  <span className="flex-1 text-sm">{i.label}</span>
                  <span className="text-sm font-semibold tabular-nums">{i.waiting}</span>
                  <span className="text-xs text-muted">waiting</span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4 rounded-lg bg-sunken p-3 text-xs text-muted">
            <div className="flex items-center justify-between">
              <span className="font-medium text-ink">Drive sync</span>
              <button className="btn btn-sm" onClick={reconcile}><IconRefresh size={13} />Reconcile now</button>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-y-1">
              <dt>Last delta</dt><dd className="text-right text-ink">{fmtAgo(data.sync?.last_delta_at)}</dd>
              <dt>Last full check</dt><dd className="text-right text-ink">{fmtAgo(data.sync?.last_full_at)}</dd>
              <dt>Operations in flight</dt><dd className="text-right text-ink">{data.inflight}</dd>
            </dl>
            {data.sync?.last_error && <div className="mt-2 text-bad">{data.sync.last_error}</div>}
          </div>
        </section>

        <section className="card p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Bills due soon</h2>
            <Link href="/bills" className="flex items-center gap-1 text-xs text-accent hover:underline">All bills <IconArrowRight size={12} /></Link>
          </div>
          {data.bills.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">Nothing due in the next two weeks.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.bills.map((b) => {
                const overdue = b.due_date < today;
                return (
                  <li key={b.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{b.name}</div>
                      <div className="text-xs text-muted">{b.payee}</div>
                    </div>
                    <span className="text-sm tabular-nums">{fmtMoney(b.expected_cents)}</span>
                    <Badge tone={overdue ? 'bad' : 'warn'}>{overdue ? `Overdue since ${fmtDate(b.due_date)}` : `Due ${fmtDate(b.due_date)}`}</Badge>
                    <Link href={`/payments?occurrence=${b.id}`} className="btn btn-sm">Pay</Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="card mt-4">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Recent activity</h2>
          <Link href="/operations" className="flex items-center gap-1 text-xs text-accent hover:underline">Operations center <IconArrowRight size={12} /></Link>
        </div>
        <ul className="divide-y divide-line">
          {data.activity.map((a) => (
            <li key={a.uid} className="flex items-start gap-3 px-4 py-2.5">
              <Badge tone={a.level === 'error' ? 'bad' : a.level === 'warn' ? 'warn' : SOURCE_TONE[a.source] ?? 'muted'}>{a.source}</Badge>
              <span className="min-w-0 flex-1 text-sm">{a.message}</span>
              {a.state === 'open' && <Badge tone="bad">open</Badge>}
              <span className="shrink-0 text-xs text-muted">{fmtAgo(a.created_at)}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
