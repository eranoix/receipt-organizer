'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { apiSend, fmtDate, fmtMoney, METHOD_LABEL, useApi } from '../client';
import { FolderSelect, type FolderOpt } from '../FolderSelect';
import { IconCalendar, IconPlus } from '../icons';
import { useToast } from '../toast';
import { Badge, Field, Modal, PageHeader, Spinner } from '../ui';

interface Bill { id: number; name: string; payee: string; amount_cents: number; tolerance_pct: number; due_day: number; method: string; folder_path: string | null; active: boolean }
interface Occ {
  id: number; bill_id: number; due_date: string; expected_cents: number; status: 'open' | 'paid' | 'skipped'; match_score: number | null; match_kind: string | null;
  receipt_file_id: string | null; receipt_name: string | null; paid_cents: number | null; paid_on: string | null; payment_status: string | null;
}

function occTone(o: Occ, today: string): ['ok' | 'bad' | 'warn' | 'muted', string] {
  if (o.status === 'paid') return ['ok', 'Paid'];
  if (o.status === 'skipped') return ['muted', 'Skipped'];
  if (o.payment_status === 'processing' || o.payment_status === 'submitted') return ['warn', 'Payment in flight'];
  if (o.due_date < today) return ['bad', 'Overdue'];
  return ['warn', 'Open'];
}

export function Bills({ canWrite }: { canWrite: boolean }) {
  const { data, reload } = useApi<{ bills: Bill[]; occurrences: Occ[]; today: string }>('/api/bills', 10_000);
  const { data: tree } = useApi<{ folders: FolderOpt[] }>('/api/files/tree');
  const [filter, setFilter] = useState<'all' | 'open' | 'paid'>('all');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', payee: '', amount: '', tolerancePct: '0', dueDay: '10', method: 'boleto', folderId: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const toast = useToast();

  const byBill = useMemo(() => {
    const m = new Map<number, Occ[]>();
    for (const o of data?.occurrences ?? []) m.set(o.bill_id, [...(m.get(o.bill_id) ?? []), o]);
    return m;
  }, [data]);

  if (!data) return <div className="flex justify-center py-20 text-muted"><Spinner size={20} /></div>;
  const today = data.today;
  const occs = data.occurrences.filter((o) => (filter === 'all' ? o.due_date <= addDays(today, 40) : filter === 'open' ? o.status === 'open' : o.status === 'paid'));
  const billName = (id: number) => data.bills.find((b) => b.id === id)?.name ?? '?';

  const occAction = async (id: number, action: string) => {
    try {
      await apiSend('POST', `/api/bills/occurrences/${id}`, { action });
      toast({ tone: 'ok', title: action === 'unmatch' ? 'Match removed; the receipt can match again' : action === 'skip' ? 'Skipped this month' : 'Reopened' });
      await reload(true);
    } catch (e) {
      toast({ tone: 'bad', title: 'That did not work', body: (e as Error).message });
    }
  };

  const create = async () => {
    try {
      await apiSend('POST', '/api/bills', {
        name: form.name, payee: form.payee, amountCents: Math.round(Number(form.amount.replace(',', '.')) * 100), tolerancePct: Number(form.tolerancePct),
        dueDay: Number(form.dueDay), method: form.method, folderId: form.folderId || null,
      });
      toast({ tone: 'ok', title: `Added "${form.name}"`, body: 'Past receipts that match were linked right away.' });
      setAdding(false);
      setErrors({});
      await reload(true);
    } catch (e) {
      setErrors(((e as { details?: Record<string, string> }).details) ?? {});
      toast({ tone: 'bad', title: 'Check the form', body: (e as Error).message });
    }
  };

  return (
    <>
      <PageHeader
        title="Bills"
        subtitle="Recurring bills, and which receipt paid each month. A receipt matches when its payment date and amount fit the bill; variable bills (power, water) also need the payee to match."
        actions={canWrite && <button className="btn btn-primary" onClick={() => setAdding(true)}><IconPlus size={14} />New bill</button>}
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {data.bills.map((b) => {
          const list = (byBill.get(b.id) ?? []).slice().sort((a, c) => a.due_date.localeCompare(c.due_date));
          const next = list.find((o) => o.status === 'open');
          return (
            <div key={b.id} className={`card p-4 ${b.active ? '' : 'opacity-60'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{b.name}</div>
                  <div className="truncate text-xs text-muted">{b.payee}</div>
                </div>
                <Badge>{METHOD_LABEL[b.method]}</Badge>
              </div>
              <div className="mt-2 text-lg font-semibold tabular-nums">{fmtMoney(b.amount_cents)}{b.tolerance_pct > 0 && <span className="ml-1 text-xs font-normal text-muted">±{b.tolerance_pct}%</span>}</div>
              <div className="text-xs text-muted">due on day {b.due_day}{next ? `, next ${fmtDate(next.due_date)}` : ''}</div>
              <div className="mt-3 flex gap-1" aria-label="Recent months">
                {list.slice(-6).map((o) => {
                  const [tone, label] = occTone(o, today);
                  return <span key={o.id} title={`${fmtDate(o.due_date)}: ${label}`} className={`h-2 flex-1 rounded-full ${tone === 'ok' ? 'bg-ok' : tone === 'bad' ? 'bg-bad' : tone === 'warn' ? 'bg-warn/70' : 'bg-line'}`} />;
                })}
              </div>
            </div>
          );
        })}
      </div>

      <section className="card mt-4 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <IconCalendar size={16} className="text-muted" />
          <span className="flex-1 text-sm font-semibold">Month by month</span>
          {(['all', 'open', 'paid'] as const).map((f) => <button key={f} className={`chip ${filter === f ? 'chip-on' : ''}`} onClick={() => setFilter(f)}>{f === 'all' ? 'Recent and upcoming' : f === 'open' ? 'Unpaid' : 'Paid'}</button>)}
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Bill</th><th>Due</th><th className="text-right">Expected</th><th>Status</th><th>Paid by</th><th className="text-right">Paid</th><th /></tr></thead>
            <tbody>
              {occs.map((o) => {
                const [tone, label] = occTone(o, today);
                return (
                  <tr key={o.id}>
                    <td className="font-medium">{billName(o.bill_id)}</td>
                    <td className="whitespace-nowrap">{fmtDate(o.due_date)}</td>
                    <td className="text-right tabular-nums">{fmtMoney(o.expected_cents)}</td>
                    <td><Badge tone={tone}>{label}</Badge></td>
                    <td className="max-w-[260px]">
                      {o.receipt_name ? (
                        <div className="truncate text-xs">
                          <Link className="text-accent hover:underline" href={`/operations?subject=${o.receipt_file_id}`}>{o.receipt_name}</Link>
                          <div className="text-muted">{o.match_kind === 'manual' ? 'matched by hand' : `auto-matched${o.match_score != null ? ` (${Math.round(o.match_score * 100)}%)` : ''}`}{o.paid_on ? `, paid ${fmtDate(o.paid_on)}` : ''}</div>
                        </div>
                      ) : <span className="text-xs text-muted">-</span>}
                    </td>
                    <td className="text-right tabular-nums">{o.paid_cents != null ? fmtMoney(o.paid_cents) : ''}</td>
                    <td className="whitespace-nowrap text-right">
                      {canWrite && o.status === 'open' && <><Link className="btn btn-sm btn-primary" href={`/payments?occurrence=${o.id}`}>Pay</Link> <button className="btn btn-sm btn-ghost" onClick={() => occAction(o.id, 'skip')}>Skip</button></>}
                      {canWrite && o.status === 'paid' && <button className="btn btn-sm btn-ghost" onClick={() => occAction(o.id, 'unmatch')}>Unmatch</button>}
                      {canWrite && o.status === 'skipped' && <button className="btn btn-sm btn-ghost" onClick={() => occAction(o.id, 'reopen')}>Reopen</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <Modal open={adding} onClose={() => setAdding(false)} title="New recurring bill"
        footer={<><button className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn btn-primary" onClick={create}>Add bill</button></>}>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Field label="Name" error={errors.name}><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Gas" /></Field></div>
          <div className="col-span-2"><Field label="Payee (as it appears on receipts)" error={errors.payee}><input className="input" value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} /></Field></div>
          <Field label="Amount (R$)" error={errors.amountCents}><input className="input" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
          <Field label="Varies by up to (%)" error={errors.tolerancePct} hint="0 for fixed amounts"><input className="input" inputMode="numeric" value={form.tolerancePct} onChange={(e) => setForm({ ...form, tolerancePct: e.target.value })} /></Field>
          <Field label="Due day (1 to 28)" error={errors.dueDay}><input className="input" inputMode="numeric" value={form.dueDay} onChange={(e) => setForm({ ...form, dueDay: e.target.value })} /></Field>
          <Field label="Paid by" error={errors.method}>
            <select className="input" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              {['pix', 'boleto', 'transfer', 'card'].map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
            </select>
          </Field>
          <div className="col-span-2"><Field label="Folder its receipts go to (optional)"><FolderSelect folders={tree?.folders ?? []} value={form.folderId} onChange={(v) => setForm({ ...form, folderId: v })} placeholder="No folder" /></Field></div>
        </div>
      </Modal>
    </>
  );
}

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
