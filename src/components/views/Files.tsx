'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { apiSend, fmtBytes, fmtDate, fmtMoney, newKey, useApi } from '../client';
import { FolderSelect, type FolderOpt } from '../FolderSelect';
import { IconChevron, IconDownload, IconFile, IconFolder, IconFolderOpen, IconInbox, IconPencil, IconPlus, IconRefresh, IconSearch, IconTrash, IconX } from '../icons';
import { Preview } from '../Preview';
import { useToast } from '../toast';
import { Badge, Empty, Modal, PageHeader, Spinner, StageBadge } from '../ui';

interface TreeFolder extends FolderOpt { name: string; files: number; pending: number }
interface Item {
  id: string; name: string; isFolder: boolean; size: number; mime: string | null; path: string; stage: string | null; payee: string | null;
  amountCents: number | null; paymentDate: string | null; pending?: { label: string; tone: 'pending' | 'failed'; detail?: string | null }; ghost?: boolean;
}
interface Listing { folder: { id: string; name: string; path: string; inbox: string | null }; crumbs: { id: string; name: string }[]; items: Item[] }

const DND = 'application/x-receipt-items';

export function Files({ canWrite }: { canWrite: boolean }) {
  const sp = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const folderId = sp.get('folder') ?? '';
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Item | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [modal, setModal] = useState<null | 'new' | 'rename' | 'move' | 'delete'>(null);
  const [name, setName] = useState('');
  const [moveTo, setMoveTo] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());

  const { data: tree, reload: reloadTree } = useApi<{ folders: TreeFolder[] }>('/api/files/tree', 8_000);
  const listUrl = `/api/files?${folderId ? `folder=${folderId}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const { data: list, reload } = useApi<Listing>(listUrl, 3_000);

  const go = useCallback((id: string) => {
    setSelected(new Set());
    setPreview(null);
    router.push(`/files?folder=${id}`, { scroll: false });
  }, [router]);

  const folders = useMemo(() => tree?.folders ?? [], [tree]);
  const root = folders.find((f) => !f.parentId);
  const children = useMemo(() => {
    const m = new Map<string, TreeFolder[]>();
    for (const f of folders) if (f.parentId) m.set(f.parentId, [...(m.get(f.parentId) ?? []), f]);
    return m;
  }, [folders]);
  const current = list?.folder;
  const currentTree = folders.find((f) => f.id === current?.id);

  const act = async (body: unknown, ok: string) => {
    try {
      await apiSend('POST', '/api/files', body, newKey('tr'));
      toast({ tone: 'ok', title: ok, body: 'Queued. The drive confirms in a moment.' });
      setSelected(new Set());
      setModal(null);
      void reload(true);
      setTimeout(() => void reloadTree(true), 1500);
    } catch (e) {
      toast({ tone: 'bad', title: 'That did not work', body: (e as Error).message });
    }
  };

  const onDrop = (targetId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    setDropTarget(null);
    const ids = JSON.parse(e.dataTransfer.getData(DND) || '[]') as string[];
    const valid = ids.filter((id) => id !== targetId);
    if (!canWrite || valid.length === 0) return;
    const dest = folders.find((f) => f.id === targetId);
    void act({ action: 'move', ids: valid, targetId }, `Moving ${valid.length} item(s) to ${dest?.path ?? 'folder'}`);
  };
  const dropProps = (id: string, locked: boolean) => (canWrite && !locked ? {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(DND)) { e.preventDefault(); setDropTarget(id); } },
    onDragLeave: () => setDropTarget((t) => (t === id ? null : t)),
    onDrop: onDrop(id),
  } : {});
  const dragIds = (id: string) => (selected.has(id) ? [...selected] : [id]);

  const download = async (ids: string[]) => {
    try {
      const res = await fetch('/api/files/zip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Download failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? 'receipts.zip';
      a.click();
      URL.revokeObjectURL(a.href);
      toast({ tone: 'ok', title: `Downloaded ${res.headers.get('x-file-count')} file(s) as ZIP` });
    } catch (e) {
      toast({ tone: 'bad', title: 'Download failed', body: (e as Error).message });
    }
  };

  const reread = async () => {
    try {
      const r = await apiSend<{ total: number }>('POST', '/api/receipts/reprocess', { fileIds: [...selected] });
      toast({ tone: 'ok', title: `Re-reading ${r.total} receipt(s) in the background` });
      setSelected(new Set());
    } catch (e) {
      toast({ tone: 'bad', title: 'Could not start', body: (e as Error).message });
    }
  };

  const renderNode = (f: TreeFolder, depth: number): React.ReactNode => {
    const kids = children.get(f.id) ?? [];
    const expanded = open.has(f.id) || depth === 0 || (current?.path ?? '').startsWith(`${f.path}/`);
    const isCurrent = current?.id === f.id;
    return (
      <li key={f.id}>
        <div
          draggable={canWrite && !!f.parentId && !f.inbox && !f.locked}
          onDragStart={(e) => e.dataTransfer.setData(DND, JSON.stringify([f.id]))}
          {...dropProps(f.id, f.locked)}
          className={`group flex items-center gap-1 rounded-md py-1 pr-2 text-sm ${isCurrent ? 'bg-accent/10 font-medium text-accent' : f.locked ? 'text-muted' : 'hover:bg-sunken'} ${dropTarget === f.id ? 'ring-2 ring-accent' : ''}`}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          <button className={`p-0.5 text-muted ${kids.length ? '' : 'invisible'}`} onClick={() => { const n = new Set(open); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); setOpen(n); }} aria-label="Expand">
            <IconChevron size={12} className={`transition ${expanded ? 'rotate-90' : ''}`} />
          </button>
          <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" disabled={f.locked} onClick={() => go(f.id)} title={f.locked ? 'Outside your access' : f.path}>
            {f.inbox ? <IconInbox size={15} className="shrink-0 text-accent" /> : isCurrent ? <IconFolderOpen size={15} className="shrink-0" /> : <IconFolder size={15} className="shrink-0" />}
            <span className="truncate">{f.name}</span>
          </button>
          {f.pending > 0 && <span className="rounded-full bg-warn/15 px-1.5 text-[10px] font-semibold text-warn">{f.pending}</span>}
          {f.files > 0 && !f.pending && <span className="text-[10px] text-muted">{f.files}</span>}
        </div>
        {expanded && kids.length > 0 && <ul>{kids.map((k) => renderNode(k, depth + 1))}</ul>}
      </li>
    );
  };

  const items = list?.items ?? [];
  const selectedItems = items.filter((i) => selected.has(i.id));
  const allOn = items.length > 0 && items.every((i) => selected.has(i.id));
  const canEditFolder = canWrite && !!currentTree?.parentId;

  return (
    <>
      <PageHeader title="Files" subtitle="The drive as it is, plus what is on its way. Drag files or folders onto a folder in the tree to move them. Every change goes through the operation queue." />
      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="card self-start p-2 lg:sticky lg:top-20">
          <div className="mb-1 flex items-center justify-between px-2 py-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Folders</span>
            {canWrite && current && <button className="btn btn-ghost btn-sm" onClick={() => { setName(''); setModal('new'); }} title="New folder here"><IconPlus size={14} /></button>}
          </div>
          {root ? <ul>{renderNode(root, 0)}</ul> : <div className="flex justify-center py-8"><Spinner /></div>}
        </aside>

        <section className="card min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm" aria-label="Breadcrumb">
              {list?.crumbs.map((c, i) => (
                <span key={c.id} className="flex items-center gap-1">
                  {i > 0 && <IconChevron size={12} className="text-muted" />}
                  <button className={i === list.crumbs.length - 1 ? 'font-semibold' : 'text-muted hover:text-ink'} onClick={() => go(c.id)} {...dropProps(c.id, false)}>{c.name}</button>
                </span>
              ))}
              {current?.inbox && <Badge tone="accent">inbox</Badge>}
            </nav>
            <div className="relative">
              <IconSearch size={14} className="absolute left-2.5 top-2.5 text-muted" />
              <input className="input w-52 pl-8" placeholder="Search in this folder" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {canEditFolder && (
              <>
                <button className="btn btn-sm" onClick={() => { setName(current!.name); setModal('rename'); }}><IconPencil size={13} />Rename</button>
                {!current?.inbox && <button className="btn btn-sm btn-danger" onClick={() => { setSelected(new Set([current!.id])); setModal('delete'); }}><IconTrash size={13} />Delete folder</button>}
              </>
            )}
          </div>

          {selected.size > 0 && modal !== 'delete' && (
            <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent/5 px-3 py-2 text-sm">
              <span className="font-medium">{selected.size} selected</span>
              {canWrite && <button className="btn btn-sm" onClick={() => { setMoveTo(''); setModal('move'); }}>Move to...</button>}
              <button className="btn btn-sm" onClick={() => download([...selected])}><IconDownload size={13} />ZIP</button>
              {canWrite && <button className="btn btn-sm" onClick={reread}><IconRefresh size={13} />Re-read</button>}
              {canWrite && <button className="btn btn-sm btn-danger" onClick={() => setModal('delete')}><IconTrash size={13} />Delete</button>}
              <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}><IconX size={13} />Clear</button>
            </div>
          )}

          <div className="grid xl:grid-cols-[minmax(0,1fr)_auto]">
            <div className="max-h-[calc(100vh-250px)] min-w-0 overflow-auto scroll-thin">
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="w-8"><input type="checkbox" aria-label="Select all" checked={allOn} onChange={() => setSelected(allOn ? new Set() : new Set(items.filter((i) => !i.ghost).map((i) => i.id)))} /></th>
                    <th>Name</th>
                    {!preview && <th>Payee</th>}
                    <th className="text-right">Amount</th>
                    {!preview && <th>Paid on</th>}
                    {!preview && <th className="text-right">Size</th>}
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id} draggable={canWrite && !it.ghost} onDragStart={(e) => e.dataTransfer.setData(DND, JSON.stringify(dragIds(it.id)))}
                      {...(it.isFolder ? dropProps(it.id, false) : {})}
                      className={`row ${selected.has(it.id) ? 'selected' : ''} ${it.ghost ? 'opacity-60' : ''} ${dropTarget === it.id ? 'outline outline-2 outline-accent' : ''}`}
                      onClick={() => (it.isFolder ? go(it.id) : setPreview(it))}>
                      <td onClick={(e) => e.stopPropagation()}>
                        {!it.ghost && <input type="checkbox" aria-label={`Select ${it.name}`} checked={selected.has(it.id)} onChange={() => { const n = new Set(selected); if (n.has(it.id)) n.delete(it.id); else n.add(it.id); setSelected(n); }} />}
                      </td>
                      <td className="max-w-[320px]">
                        <div className="flex items-center gap-2">
                          {it.isFolder ? <IconFolder size={16} className="shrink-0 text-accent" /> : <IconFile size={16} className="shrink-0 text-muted" />}
                          <span className="truncate font-medium" title={it.name}>{it.name}</span>
                          {it.pending && <Badge tone={it.pending.tone === 'failed' ? 'bad' : 'accent'} title={it.pending.detail ?? undefined}>{it.pending.tone === 'pending' && <Spinner size={9} />}{it.pending.label}</Badge>}
                          {!it.pending && it.stage && it.stage !== 'filed' && <StageBadge stage={it.stage} />}
                        </div>
                        {q && <div className="truncate pl-6 text-[11px] text-muted">{it.path}</div>}
                      </td>
                      {!preview && <td className="max-w-[180px] truncate text-muted">{it.payee ?? ''}</td>}
                      <td className="whitespace-nowrap text-right tabular-nums">{it.amountCents != null ? fmtMoney(it.amountCents) : ''}</td>
                      {!preview && <td className="whitespace-nowrap text-muted">{it.paymentDate ? fmtDate(it.paymentDate) : ''}</td>}
                      {!preview && <td className="text-right text-muted">{it.isFolder ? '' : fmtBytes(it.size)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              {list && items.length === 0 && <Empty title={q ? 'Nothing matches' : 'This folder is empty'} icon={<IconFolder size={28} />}>{q ? 'Try another word.' : 'Drag receipts here from another folder, or drop files into it on the drive.'}</Empty>}
              {!list && <div className="flex justify-center py-16 text-muted"><Spinner size={20} /></div>}
            </div>
            {preview && (
              <div className="w-full border-l border-line p-3 xl:w-[360px]">
                <div className="mb-2 flex items-center justify-between">
                  <span className="truncate text-sm font-semibold">{preview.name}</span>
                  <button className="text-muted hover:text-ink" onClick={() => setPreview(null)} aria-label="Close preview"><IconX /></button>
                </div>
                <Preview fileId={preview.id} name={preview.name} mime={preview.mime} height={440} />
                <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
                  <dt className="text-muted">Payee</dt><dd>{preview.payee ?? '-'}</dd>
                  <dt className="text-muted">Amount</dt><dd>{fmtMoney(preview.amountCents)}</dd>
                  <dt className="text-muted">Paid on</dt><dd>{fmtDate(preview.paymentDate)}</dd>
                  <dt className="text-muted">Where</dt><dd className="truncate" title={preview.path}>{preview.path}</dd>
                </dl>
              </div>
            )}
          </div>
        </section>
      </div>

      <Modal open={modal === 'new'} onClose={() => setModal(null)} title={`New folder in ${current?.name ?? ''}`}
        footer={<><button className="btn" onClick={() => setModal(null)}>Cancel</button><button className="btn btn-primary" disabled={!name.trim()} onClick={() => act({ action: 'createFolder', parentId: current!.id, name }, `Creating "${name}"`)}>Create</button></>}>
        <input className="input" autoFocus placeholder="Folder name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && act({ action: 'createFolder', parentId: current!.id, name }, `Creating "${name}"`)} />
      </Modal>
      <Modal open={modal === 'rename'} onClose={() => setModal(null)} title="Rename folder"
        footer={<><button className="btn" onClick={() => setModal(null)}>Cancel</button><button className="btn btn-primary" disabled={!name.trim()} onClick={() => act({ action: 'rename', id: current!.id, name }, `Renaming to "${name}"`)}>Rename</button></>}>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Modal>
      <Modal open={modal === 'move'} onClose={() => setModal(null)} title={`Move ${selected.size} item(s)`}
        footer={<><button className="btn" onClick={() => setModal(null)}>Cancel</button><button className="btn btn-primary" disabled={!moveTo} onClick={() => act({ action: 'move', ids: [...selected], targetId: moveTo }, 'Moving')}>Move</button></>}>
        <FolderSelect folders={folders} value={moveTo} onChange={setMoveTo} />
      </Modal>
      <Modal open={modal === 'delete'} onClose={() => { setModal(null); setSelected(new Set()); }} title="Delete from the drive?"
        footer={<><button className="btn" onClick={() => { setModal(null); setSelected(new Set()); }}>Cancel</button><button className="btn btn-danger" onClick={() => { const ids = [...selected]; const isCur = ids.length === 1 && ids[0] === current?.id; void act({ action: 'delete', ids }, 'Deleting').then(() => { if (isCur && currentTree?.parentId) go(currentTree.parentId); }); }}>Delete</button></>}>
        <p className="text-sm">These will be deleted from the drive itself, not only from this app:</p>
        <ul className="mt-2 max-h-40 list-disc overflow-auto pl-5 text-sm text-muted">
          {(selectedItems.length ? selectedItems.map((i) => i.name) : [current?.name ?? '']).slice(0, 20).map((n) => <li key={n}>{n}</li>)}
        </ul>
      </Modal>
    </>
  );
}
