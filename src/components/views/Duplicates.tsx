'use client';

import { useEffect, useState } from 'react';
import { apiSend, fmtAgo, fmtBytes, useApi } from '../client';
import { IconCheck, IconCopy, IconShield, IconTrash } from '../icons';
import { Preview } from '../Preview';
import { useToast } from '../toast';
import { Badge, Empty, PageHeader, Progress, Spinner } from '../ui';

interface Row {
  id: number; status: string; sha256: string; proof: { identical: boolean; bytesCompared: number; firstMismatchAt: number | null; comparedAt: string } | null;
  file_id: string; name: string; path: string; size: number; mime: string | null; original_id: string; original_name: string; original_path: string; created_at: string;
}
interface Job { id: number; status: string; total: number; done: number; failed: number; created_at: string; finished_at: string | null }

const STATUS: Record<string, ['ok' | 'warn' | 'bad' | 'accent' | 'muted', string]> = {
  suspected: ['warn', 'Same hash, not yet proven'],
  proven: ['accent', 'Byte-identical'],
  not_identical: ['muted', 'Different bytes, kept'],
  deleting: ['accent', 'Deleting'],
  deleted: ['ok', 'Deleted'],
  kept: ['muted', 'Kept on purpose'],
};

export function Duplicates({ isAdmin, canWrite }: { isAdmin: boolean; canWrite: boolean }) {
  const { data, reload } = useApi<{ rows: Row[]; jobs: Job[] }>('/api/duplicates', 4_000);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [focus, setFocus] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const toast = useToast();

  const rows = data?.rows ?? [];
  const actionable = rows.filter((r) => ['suspected', 'proven'].includes(r.status));
  const history = rows.filter((r) => !['suspected', 'proven'].includes(r.status));
  useEffect(() => { if (!focus && actionable[0]) setFocus(actionable[0]); }, [actionable, focus]);

  const act = async (action: 'verify' | 'keep' | 'delete', ids: number[]) => {
    setBusy(true);
    try {
      const res = await apiSend<{ jobId?: number; total?: number; results?: { status: string }[]; kept?: number }>('POST', '/api/duplicates', { action, ids });
      if (action === 'delete' && res.jobId) {
        setJobId(res.jobId);
        toast({ tone: 'ok', title: `Deleting ${res.total} duplicate(s)`, body: 'Each file is compared byte by byte again right before it is deleted.' });
      } else if (action === 'verify') {
        const same = res.results?.filter((r) => r.status === 'proven').length ?? 0;
        toast({ tone: 'ok', title: `${same} of ${ids.length} proven identical`, body: same < ids.length ? 'Files that differ were released for normal reading.' : undefined });
      } else {
        toast({ tone: 'ok', title: `Kept ${res.kept} file(s)`, body: 'They go on to be read and filed like any other receipt.' });
      }
      setChecked(new Set());
      await reload(true);
    } catch (e) {
      toast({ tone: 'bad', title: 'That did not work', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const activeJob = data?.jobs.find((j) => j.id === jobId) ?? data?.jobs.find((j) => j.status === 'running' || j.status === 'queued');

  return (
    <>
      <PageHeader title="Duplicates" subtitle="Files whose content hashes the same as one you already have. They are held out of review. Checking compares the actual bytes; deleting is a separate step that re-checks every file first." />

      {activeJob && (
        <div className="card mb-4 p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 font-medium">{activeJob.status === 'done' ? <IconCheck className="text-ok" /> : <Spinner />}Deletion job #{activeJob.id}</span>
            <span className="text-muted">{activeJob.done} deleted, {activeJob.failed} skipped, of {activeJob.total}</span>
          </div>
          <Progress value={activeJob.done + activeJob.failed} max={activeJob.total} tone={activeJob.status === 'done' ? 'ok' : 'accent'} />
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-sm">
            <span className="font-medium">{actionable.length} waiting for a decision</span>
            {checked.size > 0 && canWrite && (
              <>
                <button className="btn btn-sm" disabled={busy} onClick={() => act('verify', [...checked])}><IconShield size={13} />Check bytes</button>
                <button className="btn btn-sm" disabled={busy} onClick={() => act('keep', [...checked])}>Keep</button>
                {isAdmin && <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => act('delete', [...checked])}><IconTrash size={13} />Delete {checked.size}</button>}
              </>
            )}
          </div>
          <ul className="divide-y divide-line">
            {actionable.map((r) => (
              <li key={r.id} className={`flex cursor-pointer gap-3 px-3 py-3 hover:bg-sunken/70 ${focus?.id === r.id ? 'bg-accent/10' : ''}`} onClick={() => setFocus(r)}>
                <input type="checkbox" className="mt-1" aria-label={`Select ${r.name}`} checked={checked.has(r.id)} onClick={(e) => e.stopPropagation()} onChange={() => { const n = new Set(checked); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); setChecked(n); }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{r.path}</span>
                    <Badge tone={STATUS[r.status][0]}>{STATUS[r.status][1]}</Badge>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted">copy of {r.original_path}</div>
                  <div className="mt-1 font-mono text-[11px] text-muted">sha256 {r.sha256.slice(0, 16)}... · {fmtBytes(r.size)} · found {fmtAgo(r.created_at)}</div>
                </div>
              </li>
            ))}
          </ul>
          {data && actionable.length === 0 && <Empty title="No duplicates waiting" icon={<IconCopy size={28} />}>New copies are caught at intake by their hash and parked here.</Empty>}
          {history.length > 0 && (
            <div className="border-t border-line">
              <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted">Decided</div>
              <ul className="divide-y divide-line text-sm">
                {history.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-muted">{r.path}</span>
                    <Badge tone={STATUS[r.status][0]}>{STATUS[r.status][1]}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="card p-4 xl:sticky xl:top-20 xl:self-start">
          {focus ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs font-semibold text-muted">The new copy</div>
                  <Preview fileId={focus.file_id} name={focus.name} mime={focus.mime} height={300} />
                </div>
                <div>
                  <div className="mb-1 text-xs font-semibold text-muted">The one you already have</div>
                  <Preview fileId={focus.original_id} name={focus.original_name} mime={focus.mime} height={300} />
                </div>
              </div>
              <div className="mt-3 rounded-lg bg-sunken p-3 text-xs">
                {focus.proof ? (
                  focus.proof.identical
                    ? <p className="text-ok"><b>Proven identical:</b> {focus.proof.bytesCompared.toLocaleString()} bytes compared one by one, {fmtAgo(focus.proof.comparedAt)}.</p>
                    : <p><b>Not identical:</b> the files differ at byte {focus.proof.firstMismatchAt}.</p>
                ) : (
                  <p className="text-muted">Only the hash matches so far. A matching hash is a strong hint, not proof: check the bytes before deleting anything.</p>
                )}
              </div>
              {canWrite && ['suspected', 'proven'].includes(focus.status) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className="btn" disabled={busy} onClick={() => act('verify', [focus.id])}><IconShield size={14} />Check bytes</button>
                  <button className="btn" disabled={busy} onClick={() => act('keep', [focus.id])}>Keep both</button>
                  {isAdmin && <button className="btn btn-danger" disabled={busy} onClick={() => act('delete', [focus.id])}><IconTrash size={14} />Delete the copy</button>}
                </div>
              )}
            </>
          ) : (
            <Empty title="Pick a duplicate">Both files are shown side by side.</Empty>
          )}
        </section>
      </div>
    </>
  );
}
