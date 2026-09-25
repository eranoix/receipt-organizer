'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { apiSend, fmtAgo, fmtDate, fmtMoney, METHOD_LABEL, newKey, useApi } from '../client';
import { IconCard, IconSend } from '../icons';
import { useToast } from '../toast';
import { Badge, Empty, Field, PageHeader, Spinner, StageBadge, Tabs } from '../ui';

interface Payment {
  id: number; method: string; payee: string; amount_cents: number; details: Record<string, string>; status: string; provider_ref: string | null;
  receipt_file_id: string | null; receipt_name: string | null; receipt_stage: string | null; error: string | null; created_at: string; settled_at: string | null;
  bill_name: string | null; due_date: string | null; created_by_name: string | null;
}
interface OpenBill { id: number; due_date: string; expected_cents: number; name: string; payee: string; method: string }

type Method = 'pix' | 'transfer' | 'boleto';
const STATUS_TONE: Record<string, 'ok' | 'bad' | 'warn' | 'accent'> = { paid: 'ok', failed: 'bad', processing: 'warn', submitted: 'accent' };

export function Payments({ canWrite }: { canWrite: boolean }) {
  const sp = useSearchParams();
  const toast = useToast();
  const { data, reload } = useApi<{ rows: Payment[]; openBills: OpenBill[] }>('/api/payments', 2_500);
  const [method, setMethod] = useState<Method>('pix');
  const [occurrence, setOccurrence] = useState<string>(sp.get('occurrence') ?? '');
  const [f, setF] = useState({ payee: '', amount: '', pixKey: '', bankCode: '', branch: '', account: '', boletoLine: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [key, setKey] = useState(() => newKey('pay'));
  const [busy, setBusy] = useState(false);

  const bills = useMemo(() => data?.openBills ?? [], [data]);
  useEffect(() => {
    const b = bills.find((x) => String(x.id) === occurrence);
    if (!b) return;
    setF((cur) => ({ ...cur, payee: b.payee, amount: (b.expected_cents / 100).toFixed(2) }));
    if (b.method === 'pix' || b.method === 'transfer' || b.method === 'boleto') setMethod(b.method);
  }, [occurrence, bills]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const res = await apiSend<{ id: number; duplicate: boolean }>('POST', '/api/payments', {
        method, payee: f.payee, amountCents: Math.round(Number(f.amount.replace(',', '.')) * 100),
        pixKey: f.pixKey, bankCode: f.bankCode, branch: f.branch, account: f.account, boletoLine: f.boletoLine,
        billOccurrenceId: occurrence ? Number(occurrence) : null, idempotencyKey: key,
      });
      toast({ tone: 'ok', title: res.duplicate ? 'Already sent; not paying twice' : 'Payment sent', body: 'The receipt lands in your inbox when the provider confirms.' });
      setKey(newKey('pay'));
      setF({ payee: '', amount: '', pixKey: '', bankCode: '', branch: '', account: '', boletoLine: '' });
      setOccurrence('');
      await reload(true);
    } catch (err) {
      setErrors(((err as { details?: Record<string, string> }).details) ?? {});
      toast({ tone: 'bad', title: 'Payment not sent', body: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <PageHeader title="Payments" subtitle="Pay a bill or a supplier by Pix, transfer or boleto. The provider sends back a receipt, which goes into your inbox and is matched to the bill like any other receipt. This demo uses a mock provider: no money moves." />
      <div className="grid gap-4 xl:grid-cols-[400px_minmax(0,1fr)]">
        {canWrite ? (
          <form onSubmit={submit} className="card self-start p-4">
            <h2 className="mb-3 text-sm font-semibold">New payment</h2>
            <Tabs<Method> value={method} onChange={setMethod} tabs={[{ id: 'pix', label: 'Pix' }, { id: 'transfer', label: 'Transfer (TED)' }, { id: 'boleto', label: 'Boleto' }]} />
            <div className="mt-4 space-y-3">
              <Field label="For a bill (optional)">
                <select className="input" value={occurrence} onChange={(e) => setOccurrence(e.target.value)}>
                  <option value="">Not linked to a bill</option>
                  {bills.map((b) => <option key={b.id} value={b.id}>{b.name}, due {fmtDate(b.due_date)} ({fmtMoney(b.expected_cents)})</option>)}
                </select>
              </Field>
              <Field label="Payee" error={errors.payee}><input className="input" value={f.payee} onChange={set('payee')} /></Field>
              <Field label="Amount (R$)" error={errors.amountCents}><input className="input" inputMode="decimal" value={f.amount} onChange={set('amount')} placeholder="0.00" /></Field>
              {method === 'pix' && <Field label="Pix key" error={errors.pixKey} hint="Email, +55 phone, tax id or random key"><input className="input" value={f.pixKey} onChange={set('pixKey')} placeholder="billing@payee.example.com" /></Field>}
              {method === 'transfer' && (
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Bank" error={errors.bankCode}><input className="input" value={f.bankCode} onChange={set('bankCode')} placeholder="999" /></Field>
                  <Field label="Branch" error={errors.branch}><input className="input" value={f.branch} onChange={set('branch')} placeholder="0000" /></Field>
                  <Field label="Account" error={errors.account}><input className="input" value={f.account} onChange={set('account')} placeholder="12345-6" /></Field>
                </div>
              )}
              {method === 'boleto' && <Field label="Digitable line" error={errors.boletoLine} hint="47 or 48 digits"><input className="input font-mono" value={f.boletoLine} onChange={set('boletoLine')} /></Field>}
              <button className="btn btn-primary w-full py-2" disabled={busy}><IconSend size={14} />{busy ? 'Sending...' : `Send ${f.amount ? fmtMoney(Math.round(Number(f.amount.replace(',', '.')) * 100)) : ''}`}</button>
              <p className="text-[11px] text-muted">Pressing twice sends once: this form carries a request id, and the provider call goes through the queue with the same id.</p>
            </div>
          </form>
        ) : (
          <div className="card self-start p-4 text-sm text-muted">You have read-only access, so you can follow payments here but not send them.</div>
        )}

        <section className="card overflow-hidden">
          <div className="border-b border-line px-4 py-3 text-sm font-semibold">History</div>
          {!data ? <div className="flex justify-center py-16"><Spinner /></div> : data.rows.length === 0 ? <Empty title="No payments yet" icon={<IconCard size={28} />} /> : (
            <ul className="divide-y divide-line">
              {data.rows.map((p) => (
                <li key={p.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{p.payee}</span>
                      <Badge tone={STATUS_TONE[p.status]}>{p.status === 'processing' ? <><Spinner size={9} /> processing</> : p.status}</Badge>
                      <Badge>{METHOD_LABEL[p.method]}</Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {p.bill_name ? `${p.bill_name} due ${fmtDate(p.due_date)} · ` : ''}by {p.created_by_name ?? 'someone'} {fmtAgo(p.created_at)}{p.provider_ref ? ` · ref ${p.provider_ref}` : ''}
                    </div>
                    {p.error && <div className="mt-1 text-xs text-bad">{p.error}</div>}
                    {p.receipt_name && (
                      <div className="mt-1 flex items-center gap-2 text-xs">
                        <span className="text-muted">Receipt:</span><span className="truncate">{p.receipt_name}</span>
                        {p.receipt_stage ? <StageBadge stage={p.receipt_stage} /> : <Badge tone="accent"><Spinner size={9} /> uploading</Badge>}
                      </div>
                    )}
                  </div>
                  <div className="text-right text-sm font-semibold tabular-nums">{fmtMoney(p.amount_cents)}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
