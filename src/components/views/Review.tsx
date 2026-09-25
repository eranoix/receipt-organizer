'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiSend, fmtDate, fmtDateTime, fmtMoney, METHOD_LABEL, newKey, useApi } from '../client';
import { FolderSelect, type FolderOpt } from '../FolderSelect';
import { IconAlert, IconCheck, IconInbox, IconRefresh, IconSearch } from '../icons';
import { Preview } from '../Preview';
import { useToast } from '../toast';
import { Badge, Confidence, Empty, PageHeader, Progress, Spinner, StageBadge, Tabs } from '../ui';

interface Row {
  file_id: string; name: string; mime: string | null; stage: string; payee: string | null; amount_cents: number | null; payment_date: string | null; method: string | null;
  confidence: number | null; suggestion_folder_id: string | null; suggestion_confidence: number | null; suggestion_path: string | null; inbox_label: string;
  proposal_run_id: number | null; filing_status: string | null; filing_error: string | null;
}
interface ListData { rows: Row[]; counts: Record<string, number>; inboxes: { folder_id: string; label: string }[] }

type Stage = 'all' | 'suggested' | 'needs_decision' | 'unreadable' | 'reading';

export function Review({ canWrite }: { canWrite: boolean }) {
  const sp = useSearchParams();
  const router = useRouter();
  const stage = (sp.get('stage') as Stage) ?? 'all';
  const inbox = sp.get('inbox') ?? '';
  const selectedId = sp.get('file');
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<number | null>(null);
  const toast = useToast();

  const url = `/api/review?stage=${stage}${inbox ? `&inbox=${inbox}` : ''}${search ? `&q=${encodeURIComponent(search)}` : ''}`;
  const { data, reload } = useApi<ListData>(url, 5_000);
  const { data: tree } = useApi<{ folders: FolderOpt[] }>('/api/files/tree');

  const setParam = useCallback((k: string, v: string | null) => {
    const p = new URLSearchParams(sp.toString());
    if (v) p.set(k, v); else p.delete(k);
    router.replace(`/review?${p.toString()}`, { scroll: false });
  }, [router, sp]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const selected = rows.find((r) => r.file_id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && rows[0]) setParam('file', rows[0].file_id);
  }, [rows, selectedId, setParam]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const i = rows.findIndex((r) => r.file_id === selectedId);
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'j' ? 1 : -1)))];
      if (next) setParam('file', next.file_id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, selectedId, setParam]);

  const confirmable = rows.filter((r) => checked.has(r.file_id) && r.suggestion_folder_id && !r.filing_status);
  const confirmChecked = async () => {
    try {
      const res = await apiSend<{ queued: unknown[]; skipped: { reason: string }[] }>('POST', '/api/review/confirm', { items: confirmable.map((r) => ({ fileId: r.file_id })) });
      toast({ tone: 'ok', title: `Filing ${res.queued.length} receipt(s)`, body: res.skipped.length ? `${res.skipped.length} skipped` : 'They move as soon as the drive confirms.' });
      setChecked(new Set());
      void reload(true);
    } catch (e) {
      toast({ tone: 'bad', title: 'Could not confirm', body: (e as Error).message });
    }
  };
  const rereadChecked = async () => {
    try {
      const res = await apiSend<{ jobId: number; total: number }>('POST', '/api/receipts/reprocess', { fileIds: [...checked] });
      setJob(res.jobId);
      toast({ tone: 'ok', title: `Re-reading ${res.total} receipt(s) in the background`, body: 'Differences come back as proposals to review.' });
      setChecked(new Set());
    } catch (e) {
      toast({ tone: 'bad', title: 'Could not start', body: (e as Error).message });
    }
  };

  const counts = data?.counts ?? {};
  const waiting = (counts.suggested ?? 0) + (counts.needs_decision ?? 0) + (counts.unreadable ?? 0) + (counts.reading ?? 0);
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.file_id));

  return (
    <>
      <PageHeader
        title="Review"
        subtitle="Receipts waiting in your inboxes. Each one has been read and gets a suggested folder; nothing moves until you confirm it."
        actions={
          <>
            <select className="input w-44" value={inbox} onChange={(e) => setParam('inbox', e.target.value || null)} aria-label="Inbox">
              <option value="">All inboxes</option>
              {data?.inboxes.map((i) => <option key={i.folder_id} value={i.folder_id}>{i.label}</option>)}
            </select>
            <div className="relative">
              <IconSearch size={14} className="absolute left-2.5 top-2.5 text-muted" />
              <input className="input w-56 pl-8" placeholder="Search name or payee" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </>
        }
      />
      <Tabs<Stage>
        value={stage}
        onChange={(v) => setParam('stage', v === 'all' ? null : v)}
        tabs={[
          { id: 'all', label: 'All waiting', count: waiting },
          { id: 'suggested', label: 'Suggested', count: counts.suggested ?? 0 },
          { id: 'needs_decision', label: 'Needs a decision', count: counts.needs_decision ?? 0 },
          { id: 'unreadable', label: 'Unreadable', count: counts.unreadable ?? 0 },
          { id: 'reading', label: 'Being read', count: counts.reading ?? 0 },
        ]}
      />

      {job && <JobBar jobId={job} onDone={() => { setJob(null); void reload(true); }} />}

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="card overflow-hidden">
          {checked.size > 0 && canWrite && (
            <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent/5 px-3 py-2 text-sm">
              <span className="font-medium">{checked.size} selected</span>
              <button className="btn btn-sm btn-primary" disabled={confirmable.length === 0} onClick={confirmChecked}><IconCheck size={13} />Confirm {confirmable.length} suggestion(s)</button>
              <button className="btn btn-sm" onClick={rereadChecked}><IconRefresh size={13} />Re-read</button>
              <button className="btn btn-sm btn-ghost" onClick={() => setChecked(new Set())}>Clear</button>
            </div>
          )}
          <div className="max-h-[calc(100vh-260px)] overflow-auto scroll-thin">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-8"><input type="checkbox" aria-label="Select all" checked={allChecked} onChange={() => setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.file_id)))} /></th>
                  <th>Receipt</th>
                  <th>Payee and date</th>
                  <th className="text-right">Amount</th>
                  <th>Suggested folder</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.file_id} className={`row ${r.file_id === selectedId ? 'selected' : ''}`} onClick={() => setParam('file', r.file_id)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${r.name}`} checked={checked.has(r.file_id)} onChange={() => {
                        const n = new Set(checked);
                        if (n.has(r.file_id)) n.delete(r.file_id); else n.add(r.file_id);
                        setChecked(n);
                      }} />
                    </td>
                    <td className="max-w-[240px]">
                      <div className="truncate font-medium" title={r.name}>{r.name}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        <IconInbox size={11} />{r.inbox_label}
                        {r.filing_status === 'dead' ? <Badge tone="bad">Filing failed</Badge>
                          : r.filing_status ? <Badge tone="accent"><Spinner size={9} /> Filing</Badge>
                          : r.stage !== 'suggested' && <StageBadge stage={r.stage} />}
                        {r.proposal_run_id && <Badge tone="warn">Re-read to review</Badge>}
                      </div>
                    </td>
                    <td className="max-w-[180px]">
                      <div className="truncate">{r.payee ?? <span className="text-muted">unknown payee</span>}</div>
                      <div className="text-xs text-muted">{fmtDate(r.payment_date)}{r.method ? ` · ${METHOD_LABEL[r.method] ?? r.method}` : ''}</div>
                    </td>
                    <td className="whitespace-nowrap text-right tabular-nums">{fmtMoney(r.amount_cents)}</td>
                    <td className="max-w-[170px]">
                      <div className="truncate text-muted" title={r.suggestion_path ?? ''}>{r.suggestion_path ?? 'no suggestion'}</div>
                      {r.suggestion_folder_id && <Confidence value={r.suggestion_confidence} compact />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data && rows.length === 0 && <Empty title="Inbox zero" icon={<IconInbox size={28} />}>Nothing is waiting here. New receipts appear as soon as they land in an inbox folder.</Empty>}
            {!data && <div className="flex justify-center py-16 text-muted"><Spinner size={20} /></div>}
          </div>
          <div className="border-t border-line px-3 py-2 text-[11px] text-muted">Tip: <span className="kbd">j</span> / <span className="kbd">k</span> move through the list.</div>
        </div>

        <div className="xl:sticky xl:top-20 xl:self-start">
          {selected ? <Detail key={selected.file_id} fileId={selected.file_id} filing={selected.filing_status === 'dead' ? selected.filing_error ?? 'failed' : null} folders={tree?.folders ?? []} canWrite={canWrite} onChanged={() => void reload(true)} />
            : <div className="card"><Empty title="Pick a receipt">Its preview, the fields that were read and the suggested folder show up here.</Empty></div>}
        </div>
      </div>
    </>
  );
}

function JobBar({ jobId, onDone }: { jobId: number; onDone: () => void }) {
  const { data } = useApi<{ status: string; total: number; done: number; failed: number }>(`/api/jobs/${jobId}`, 1_500);
  useEffect(() => { if (data?.status === 'done') onDone(); }, [data, onDone]);
  if (!data) return null;
  return (
    <div className="card mt-3 flex items-center gap-3 px-4 py-2.5 text-sm">
      <Spinner />
      <span className="whitespace-nowrap">Re-reading {data.done + data.failed} of {data.total}</span>
      <Progress value={data.done + data.failed} max={data.total} />
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = { payee: 'Payee', payeeTaxId: 'Tax id', amountCents: 'Amount', paymentDate: 'Paid on', method: 'Method', reference: 'Reference' };
const showField = (k: string, v: unknown) => (v == null || v === '' ? '(empty)' : k === 'amountCents' ? fmtMoney(v as number) : k === 'paymentDate' ? fmtDate(v as string) : k === 'method' ? METHOD_LABEL[v as string] ?? String(v) : String(v));

interface DetailData {
  receipt: Record<string, unknown> & { file_id: string; name: string; mime: string | null; stage: string; payee: string | null; payee_tax_id: string | null; amount_cents: number | null; payment_date: string | null; method: string | null; reference: string | null; confidence: number | null; edited_fields: string[]; suggestion_folder_id: string | null; suggestion_confidence: number | null; suggestion_reasons: string[]; suggestion_path: string | null; ocr_error: string | null };
  alternatives: { folderId: string; confidence: number; reasons: string[]; path: string }[];
  runs: { id: number; provider: string; trigger: string; status: string; confidence: number | null; error: string | null; duration_ms: number; created_at: string }[];
  proposal: { runId: number; before: Record<string, unknown>; after: Record<string, unknown>; changed: string[] } | null;
  bill: { name: string; due_date: string; match_score: number | null } | null;
}

function Detail({ fileId, filing, folders, canWrite, onChanged }: { fileId: string; filing: string | null; folders: FolderOpt[]; canWrite: boolean; onChanged: () => void }) {
  const { data, reload } = useApi<DetailData>(`/api/receipts/${fileId}`);
  const toast = useToast();
  const [folder, setFolder] = useState('');
  const [form, setForm] = useState<Record<string, string>>({});
  const [take, setTake] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    const r = data.receipt;
    setFolder(r.suggestion_folder_id ?? '');
    setForm({
      payee: r.payee ?? '', payeeTaxId: r.payee_tax_id ?? '', amount: r.amount_cents != null ? (r.amount_cents / 100).toFixed(2) : '',
      paymentDate: r.payment_date ?? '', method: r.method ?? '', reference: r.reference ?? '',
    });
    setTake(data.proposal ? new Set(data.proposal.changed) : null);
  }, [data]);

  if (!data) return <div className="card flex justify-center py-20 text-muted"><Spinner size={20} /></div>;
  const r = data.receipt;
  const edited = new Set(r.edited_fields ?? []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ tone: 'ok', title: ok });
      await reload(true);
      onChanged();
    } catch (e) {
      toast({ tone: 'bad', title: 'That did not work', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => {
    const amount = form.amount.trim() ? Math.round(Number(form.amount.replace(',', '.')) * 100) : null;
    await apiSend('PATCH', `/api/receipts/${fileId}`, {
      payee: form.payee, payeeTaxId: form.payeeTaxId, amountCents: amount, paymentDate: form.paymentDate || null, method: form.method || null, reference: form.reference,
    });
  }, 'Saved. The suggestion was recalculated.');

  const confirm = () => run(() => apiSend('POST', '/api/review/confirm', { items: [{ fileId, folderId: folder }] }, newKey('tr')), 'Filing queued');
  const reread = () => run(() => apiSend('POST', `/api/receipts/${fileId}/reprocess`), 'Re-reading in the background');
  const decide = (accept: boolean) => run(() => apiSend('POST', `/api/receipts/${fileId}/proposal`, { accept, fields: take ? [...take] : undefined }), accept ? 'Proposal applied' : 'Kept the current values');

  const input = (k: string, label: string, type = 'text') => (
    <label className="block">
      <span className="label flex items-center gap-1">{label}{edited.has(k === 'amount' ? 'amountCents' : k) && <Badge tone="accent">edited</Badge>}</span>
      <input className="input" type={type} value={form[k] ?? ''} disabled={!canWrite} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </label>
  );

  return (
    <div className="card divide-y divide-line">
      <div className="p-3"><Preview fileId={fileId} name={r.name} mime={r.mime} height={300} /></div>

      {filing && (
        <div className="bg-bad/5 p-4 text-sm">
          <div className="flex items-center gap-2 font-semibold text-bad"><IconAlert size={15} />Filing failed</div>
          <p className="mt-1 text-xs text-muted">{filing}. Nothing was lost: the file is still here. Replay it with a free name in the operations center, or pick another folder below.</p>
          <Link href={`/operations?subject=${fileId}&state=open`} className="btn btn-sm mt-2">Open in the operations center</Link>
        </div>
      )}

      {data.proposal && (
        <div className="bg-warn/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><IconAlert size={15} className="text-warn" />Re-reading found differences</div>
          <table className="w-full text-xs">
            <thead><tr className="text-left text-muted"><th className="w-6" /><th className="py-1">Field</th><th>Now</th><th>Re-read</th></tr></thead>
            <tbody>
              {data.proposal.changed.map((k) => (
                <tr key={k} className="border-t border-line/60">
                  <td><input type="checkbox" checked={take?.has(k) ?? false} onChange={() => { const n = new Set(take); if (n.has(k)) n.delete(k); else n.add(k); setTake(n); }} aria-label={`Take ${k}`} /></td>
                  <td className="py-1.5 font-medium">{FIELD_LABELS[k]}{edited.has(k) && <span className="ml-1 text-accent">(you edited)</span>}</td>
                  <td className="text-bad line-through decoration-bad/40">{showField(k, data.proposal!.before[k])}</td>
                  <td className="font-medium text-ok">{showField(k, data.proposal!.after[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {canWrite && (
            <div className="mt-3 flex gap-2">
              <button className="btn btn-sm btn-primary" disabled={busy || !take?.size} onClick={() => decide(true)}>Apply {take?.size ?? 0} change(s)</button>
              <button className="btn btn-sm" disabled={busy} onClick={() => decide(false)}>Keep current</button>
            </div>
          )}
        </div>
      )}

      <div className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Where it goes</h3>
          <StageBadge stage={r.stage} />
        </div>
        {r.suggestion_folder_id ? (
          <div className="rounded-lg border border-line p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{r.suggestion_path}</span>
              <Confidence value={r.suggestion_confidence} />
            </div>
            <ul className="mt-1.5 list-disc pl-4 text-xs text-muted">{(r.suggestion_reasons ?? []).map((x) => <li key={x}>{x}</li>)}</ul>
            {(r.suggestion_confidence ?? 0) < 0.8 && <p className="mt-2 text-xs text-warn">Below the 80% threshold: please check before confirming.</p>}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-line p-3 text-xs text-muted">{(r.suggestion_reasons ?? [])[0] ?? 'No suggestion.'} Pick a folder below; next time this payee is recognised.</p>
        )}
        {data.alternatives.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {data.alternatives.map((a) => (
              <button key={a.folderId} className={`chip ${folder === a.folderId ? 'chip-on' : ''}`} onClick={() => setFolder(a.folderId)} title={a.reasons.join('; ')}>{a.path} · {Math.round(a.confidence * 100)}%</button>
            ))}
          </div>
        )}
        {canWrite && (
          <div className="mt-3 flex gap-2">
            <div className="flex-1"><FolderSelect folders={folders} value={folder} onChange={setFolder} /></div>
            <button className="btn btn-primary" disabled={busy || !folder} onClick={confirm}><IconCheck size={14} />Confirm</button>
          </div>
        )}
      </div>

      <div className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">What was read</h3>
          <span className="text-xs text-muted">confidence {r.confidence != null ? `${Math.round(r.confidence * 100)}%` : '-'}</span>
        </div>
        {r.ocr_error && <p className="mb-2 rounded-lg bg-bad/10 px-3 py-2 text-xs text-bad">{r.ocr_error}</p>}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="col-span-2">{input('payee', 'Payee')}</div>
          {input('amount', 'Amount (R$)')}
          {input('paymentDate', 'Paid on', 'date')}
          <label className="block">
            <span className="label flex items-center gap-1">Method{edited.has('method') && <Badge tone="accent">edited</Badge>}</span>
            <select className="input" value={form.method ?? ''} disabled={!canWrite} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              <option value="">Unknown</option>
              {Object.entries(METHOD_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {input('payeeTaxId', 'Tax id')}
          <div className="col-span-2">{input('reference', 'Reference')}</div>
        </div>
        {canWrite && (
          <div className="mt-3 flex gap-2">
            <button className="btn btn-sm" disabled={busy} onClick={save}>Save fields</button>
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={reread}><IconRefresh size={13} />Re-read</button>
          </div>
        )}
        {data.bill && <p className="mt-3 rounded-lg bg-ok/10 px-3 py-2 text-xs text-ok">Pays <b>{data.bill.name}</b> due {fmtDate(data.bill.due_date)}{data.bill.match_score != null && ` (match ${Math.round(data.bill.match_score * 100)}%)`}.</p>}
      </div>

      <div className="p-4">
        <h3 className="mb-2 text-sm font-semibold">Reading history</h3>
        <ul className="space-y-1 text-xs">
          {data.runs.map((x) => (
            <li key={x.id} className="flex items-center gap-2">
              <Badge tone={x.status === 'failed' ? 'bad' : x.status === 'rate_limited' || x.status === 'proposed' ? 'warn' : 'muted'}>{x.status.replace('_', ' ')}</Badge>
              <span className="text-muted">{x.trigger} via {x.provider}, {x.duration_ms} ms</span>
              <span className="ml-auto text-muted">{fmtDateTime(x.created_at)}</span>
            </li>
          ))}
        </ul>
        <Link href={`/operations?subject=${fileId}`} className="mt-2 inline-block text-xs text-accent hover:underline">Everything that happened to this file</Link>
      </div>
    </div>
  );
}
