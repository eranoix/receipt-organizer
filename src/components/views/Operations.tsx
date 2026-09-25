'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiSend, fmtAgo, fmtDateTime, useApi } from '../client';
import { IconActivity, IconLink, IconSearch, IconX } from '../icons';
import { useToast } from '../toast';
import { Badge, Empty, PageHeader, Spinner, Tabs } from '../ui';

interface Row {
  uid: string; source: string; level: 'info' | 'warn' | 'error'; action: string; message: string; subject_id: string | null; subject_name: string | null;
  trace_id: string | null; created_at: string; state: 'open' | 'handled' | 'info'; detail: Record<string, unknown>; actor: string | null;
}
interface Page { rows: Row[]; total: number; page: number; pageSize: number; counts: { state: Record<string, number>; source: Record<string, number> } }
interface Detail {
  row: Row & { subject_path: string | null };
  attempts: { attempt_number: number; outcome: string; error: string | null; error_code: string | null; duration_ms: number; started_at: string }[];
  related: { uid: string; source: string; level: string; action: string; message: string; created_at: string; state: string }[];
}

const SOURCES = ['queue', 'ocr', 'sync', 'dedup', 'payment', 'audit', 'system'];
type State = 'open' | 'handled' | 'info' | 'all';
const LEVEL_TONE = { info: 'muted', warn: 'warn', error: 'bad' } as const;

function actionsFor(r: Row, isAdmin: boolean): { id: string; label: string; danger?: boolean }[] {
  const d = r.detail as { status?: string; errorCode?: string };
  const out: { id: string; label: string; danger?: boolean }[] = [];
  if (r.uid.startsWith('op-') && isAdmin && (d.status === 'dead' || d.status === 'discarded')) {
    out.push({ id: 'replay', label: 'Replay' });
    if (d.errorCode === 'nameAlreadyExists') out.push({ id: 'replay_renamed', label: 'Replay with a free name' });
    if (d.status === 'dead') out.push({ id: 'discard', label: 'Discard', danger: true });
  }
  if (r.uid.startsWith('ocr-') && r.state === 'open') out.push({ id: 'retry', label: 'Read again' }, { id: 'handle', label: 'Dismiss' });
  if (r.uid.startsWith('ev-') && r.state === 'open') out.push({ id: 'handle', label: 'Mark handled' });
  return out;
}

export function Operations({ isAdmin }: { isAdmin: boolean }) {
  const sp = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const state = (sp.get('state') as State) ?? 'open';
  const source = sp.get('source') ?? '';
  const trace = sp.get('trace') ?? '';
  const subject = sp.get('subject') ?? '';
  const page = Number(sp.get('page') ?? 1);
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(q), 300); return () => clearTimeout(t); }, [q]);

  const set = useCallback((patch: Record<string, string | null>) => {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    if (!('page' in patch)) p.delete('page');
    router.replace(`/operations?${p.toString()}`, { scroll: false });
    setSelected(new Set());
  }, [router, sp]);

  // A trace or subject filter is about the whole story, problems or not.
  const effectiveState = trace || subject ? (sp.get('state') ?? 'all') : state;
  const qs = new URLSearchParams({ state: effectiveState, page: String(page), pageSize: '25' });
  if (source) qs.set('source', source);
  if (trace) qs.set('trace', trace);
  if (subject) qs.set('subject', subject);
  if (debounced) qs.set('q', debounced);
  const { data, reload } = useApi<Page>(`/api/ops/logs?${qs.toString()}`, 8_000);
  const { data: detail, reload: reloadDetail } = useApi<Detail>(focus ? `/api/ops/logs/${focus}` : null);

  const run = async (uids: string[], action: string) => {
    try {
      const res = await apiSend<{ done: number; failed: number; results: { ok: boolean; result: string }[] }>('POST', '/api/ops/actions', { uids, action });
      const firstErr = res.results.find((r) => !r.ok)?.result;
      toast({ tone: res.failed ? 'bad' : 'ok', title: `${res.done} done${res.failed ? `, ${res.failed} not applicable` : ''}`, body: firstErr });
      setSelected(new Set());
      await reload(true);
      if (focus) await reloadDetail(true);
    } catch (e) {
      toast({ tone: 'bad', title: 'That did not work', body: (e as Error).message });
    }
  };

  const rows = data?.rows ?? [];
  const c = data?.counts;
  const from = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? Math.min(data.total, data.page * data.pageSize) : 0;
  const selRows = rows.filter((r) => selected.has(r.uid));
  const bulk = [
    { id: 'handle', label: 'Mark handled', ok: selRows.some((r) => r.state === 'open' && !r.uid.startsWith('op-')) },
    { id: 'replay', label: 'Replay', ok: isAdmin && selRows.some((r) => r.uid.startsWith('op-')) },
    { id: 'retry', label: 'Read again', ok: selRows.some((r) => r.uid.startsWith('ocr-')) },
    { id: 'discard', label: 'Discard', ok: isAdmin && selRows.some((r) => r.uid.startsWith('op-')) },
  ].filter((b) => b.ok);

  return (
    <>
      <PageHeader title="Operations center" subtitle="Every log in one place: the audit trail, the operation queue, receipt reading, sync and duplicates. Problems stay open until someone deals with them, and every row says what can be done." />

      <Tabs<State>
        value={effectiveState as State}
        onChange={(v) => set({ state: v })}
        tabs={[
          { id: 'open', label: 'Open problems', count: c?.state.open ?? 0 },
          { id: 'handled', label: 'Handled', count: c?.state.handled ?? 0 },
          { id: 'info', label: 'Activity', count: c?.state.info ?? 0 },
          { id: 'all', label: 'Everything', count: Object.values(c?.state ?? {}).reduce((a, b) => a + b, 0) },
        ]}
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <IconSearch size={14} className="absolute left-2.5 top-2.5 text-muted" />
          <input className="input w-64 pl-8" placeholder="Search messages, files, trace ids" value={q} onChange={(e) => { setQ(e.target.value); if (page !== 1) set({ page: null }); }} />
        </div>
        <button className={`chip ${!source ? 'chip-on' : ''}`} onClick={() => set({ source: null })}>All sources</button>
        {SOURCES.map((s) => (
          <button key={s} className={`chip ${source === s ? 'chip-on' : ''}`} onClick={() => set({ source: source === s ? null : s })}>
            {s}<span className="tabular-nums opacity-70">{c?.source[s] ?? 0}</span>
          </button>
        ))}
        {trace && <span className="chip chip-on"><IconLink size={12} />trace {trace.slice(0, 14)}<button onClick={() => set({ trace: null })} aria-label="Clear trace"><IconX size={12} /></button></span>}
        {subject && <span className="chip chip-on">one file<button onClick={() => set({ subject: null })} aria-label="Clear file filter"><IconX size={12} /></button></span>}
      </div>

      <div className="mt-3 grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="card min-w-0 overflow-hidden">
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent/5 px-3 py-2 text-sm">
              <span className="font-medium">{selected.size} selected</span>
              {bulk.map((b) => <button key={b.id} className={`btn btn-sm ${b.id === 'discard' ? 'btn-danger' : ''}`} onClick={() => run([...selected], b.id)}>{b.label}</button>)}
              {bulk.length === 0 && <span className="text-xs text-muted">No action applies to all of these.</span>}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="tbl table-fixed">
              <colgroup><col className="w-8" /><col className="w-24" /><col className="w-24" /><col /><col className="w-36" /><col className="w-24" /></colgroup>
              <thead>
                <tr>
                  <th><input type="checkbox" aria-label="Select page" checked={rows.length > 0 && rows.every((r) => selected.has(r.uid))} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.uid)) : new Set())} /></th>
                  <th>When</th><th>Source</th><th>What happened</th><th>File</th><th>State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.uid} className={`row ${focus === r.uid ? 'selected' : ''}`} onClick={() => setFocus(r.uid)}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label="Select row" checked={selected.has(r.uid)} onChange={() => { const n = new Set(selected); if (n.has(r.uid)) n.delete(r.uid); else n.add(r.uid); setSelected(n); }} /></td>
                    <td className="whitespace-nowrap text-xs text-muted" title={fmtDateTime(r.created_at)}>{fmtAgo(r.created_at)}</td>
                    <td><Badge tone={LEVEL_TONE[r.level]}>{r.source}</Badge></td>
                    <td className="min-w-0">
                      <div className="line-clamp-2" title={r.message}>{r.message}</div>
                      <div className="truncate text-[11px] text-muted">{r.action}{r.actor ? ` · ${r.actor}` : ''}</div>
                    </td>
                    <td className="truncate text-xs text-muted" title={r.subject_name ?? ''}>{r.subject_name ?? ''}</td>
                    <td>{r.state === 'open' ? <Badge tone="bad">open</Badge> : r.state === 'handled' ? <Badge tone="ok">handled</Badge> : <span className="text-xs text-muted">-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data && rows.length === 0 && <Empty title={effectiveState === 'open' ? 'Nothing open' : 'Nothing here'} icon={<IconActivity size={28} />}>{effectiveState === 'open' ? 'Every problem has been dealt with.' : 'Try another filter.'}</Empty>}
          {!data && <div className="flex justify-center py-16"><Spinner size={20} /></div>}
          {data && data.total > 0 && (
            <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-muted">
              <span>{from} to {to} of {data.total}</span>
              <div className="flex gap-1">
                <button className="btn btn-sm" disabled={data.page <= 1} onClick={() => set({ page: String(data.page - 1) })}>Previous</button>
                <button className="btn btn-sm" disabled={to >= data.total} onClick={() => set({ page: String(data.page + 1) })}>Next</button>
              </div>
            </div>
          )}
        </section>

        <aside className="card self-start xl:sticky xl:top-20">
          {!focus ? <Empty title="Pick a row">Details, attempts, the actions that apply and everything else with the same trace show up here.</Empty> : !detail ? <div className="flex justify-center py-16"><Spinner /></div> : (
            <div className="divide-y divide-line">
              <div className="p-4">
                <div className="flex items-center gap-2">
                  <Badge tone={LEVEL_TONE[detail.row.level]}>{detail.row.source}</Badge>
                  <span className="text-xs text-muted">{detail.row.action}</span>
                  <button className="ml-auto text-muted hover:text-ink" onClick={() => setFocus(null)} aria-label="Close"><IconX /></button>
                </div>
                <p className="mt-2 text-sm">{detail.row.message}</p>
                <dl className="mt-3 grid grid-cols-[90px_1fr] gap-y-1 text-xs">
                  <dt className="text-muted">When</dt><dd>{fmtDateTime(detail.row.created_at)}</dd>
                  {detail.row.actor && <><dt className="text-muted">Who</dt><dd>{detail.row.actor}</dd></>}
                  {detail.row.subject_path && <><dt className="text-muted">File</dt><dd className="break-all">{detail.row.subject_path}</dd></>}
                  {detail.row.trace_id && <><dt className="text-muted">Trace</dt><dd><button className="font-mono text-accent hover:underline" onClick={() => set({ trace: detail.row.trace_id })}>{detail.row.trace_id}</button></dd></>}
                </dl>
                {actionsFor(detail.row, isAdmin).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {actionsFor(detail.row, isAdmin).map((a) => <button key={a.id} className={`btn btn-sm ${a.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => run([detail.row.uid], a.id)}>{a.label}</button>)}
                  </div>
                )}
              </div>
              {detail.attempts.length > 0 && (
                <div className="p-4">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Attempts</h3>
                  <ol className="space-y-1.5 text-xs">
                    {detail.attempts.map((a) => (
                      <li key={a.attempt_number} className="flex gap-2">
                        <span className="w-4 text-muted">{a.attempt_number}</span>
                        <span className="shrink-0"><Badge tone={a.outcome === 'applied' || a.outcome === 'noop' ? 'ok' : a.outcome === 'permanent' ? 'bad' : 'warn'}>{a.outcome}</Badge></span>
                        <span className="min-w-0 flex-1 break-words text-muted">{a.error_code ? `${a.error_code}: ` : ''}{a.error ?? ''}</span>
                        <span className="text-muted">{a.duration_ms} ms</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {detail.related.length > 1 && (
                <div className="p-4">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Same trace</h3>
                  <ol className="relative space-y-2 border-l border-line pl-4 text-xs">
                    {detail.related.map((x) => (
                      <li key={x.uid} className={x.uid === detail.row.uid ? 'font-medium' : ''}>
                        <span className={`absolute -left-[5px] mt-1 h-2 w-2 rounded-full ${x.level === 'error' ? 'bg-bad' : x.level === 'warn' ? 'bg-warn' : 'bg-line'}`} />
                        <button className="text-left hover:text-accent" onClick={() => setFocus(x.uid)}>
                          <span className="text-muted">{x.source} · {fmtDateTime(x.created_at)}</span><br />{x.message}
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              <details className="p-4">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">Raw detail</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-sunken p-2 text-[11px]">{JSON.stringify(detail.row.detail, (k, v) => (k === 'contentB64' ? '(file bytes)' : v), 2)}</pre>
              </details>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
