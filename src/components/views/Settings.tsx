'use client';

import { useState } from 'react';
import { apiSend, fmtAgo, useApi } from '../client';
import { FolderSelect, type FolderOpt } from '../FolderSelect';
import { IconInbox, IconPlus, IconTrash } from '../icons';
import { useToast } from '../toast';
import { Avatar, Badge, Field, Modal, PageHeader, Spinner, Tabs } from '../ui';

interface SettingsData {
  settings: Record<'dedup.enabled', boolean>;
  inboxes: { folder_id: string; label: string; is_primary: boolean; path: string; files: number }[];
  rules: { id: number; pattern: string; folder_id: string; path: string | null }[];
  extractor: string; drive: string;
}
interface UserRow { id: number; email: string; name: string; role: string; avatar_color: string; disabled: boolean; last_login_at: string | null; scopes: { id: string; path: string }[] }

type Tab = 'general' | 'inboxes' | 'rules' | 'users';

export function Settings({ isAdmin, meId }: { isAdmin: boolean; meId: number }) {
  const [tab, setTab] = useState<Tab>('general');
  const { data, reload } = useApi<SettingsData>('/api/settings');
  const { data: tree } = useApi<{ folders: FolderOpt[] }>('/api/files/tree');
  const toast = useToast();

  const patch = async (body: unknown, ok: string) => {
    try {
      await apiSend('PATCH', '/api/settings', body);
      toast({ tone: 'ok', title: ok });
      await reload(true);
    } catch (e) {
      toast({ tone: 'bad', title: 'Not saved', body: (e as Error).message });
    }
  };

  return (
    <>
      <PageHeader title="Settings" subtitle={isAdmin ? 'How receipts are read and checked, where they arrive, and who can see what.' : 'Only admins can change settings; this is a read-only view.'} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'general', label: 'Reading and duplicates' }, { id: 'inboxes', label: 'Inboxes' }, { id: 'rules', label: 'Folder rules' },
        ...(isAdmin ? [{ id: 'users' as const, label: 'People and access' }] : []),
      ]} />
      <div className="mt-4">
        {!data ? <div className="flex justify-center py-16"><Spinner /></div> : tab === 'general' ? (
          <div className="card divide-y divide-line">
            <Toggle label="Duplicate detection" hint="Hash every new file at intake and hold exact copies out of review. On by default; turning it off lets copies through as normal receipts."
              on={data.settings['dedup.enabled']} disabled={!isAdmin} onChange={(v) => patch({ 'dedup.enabled': v }, `Duplicate detection ${v ? 'on' : 'off'}`)} />
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <div><div className="label">Extractor</div><div className="text-sm">{data.extractor === 'mock' ? 'Deterministic mock (reads the text layer; set EXTRACTOR=http for a real OCR/LLM service)' : 'HTTP provider'}</div></div>
              <div><div className="label">Drive</div><div className="text-sm">{data.drive === 'local' ? 'Local fake drive (a directory with a change feed; set DRIVE_ADAPTER=graph for OneDrive)' : 'Microsoft Graph'}</div></div>
              <div><div className="label">Suggestion threshold</div><div className="text-sm">80%. Below it a receipt is flagged &quot;needs a decision&quot;; above it you can confirm in bulk. Either way a person confirms.</div></div>
            </div>
          </div>
        ) : tab === 'inboxes' ? (
          <Inboxes data={data} folders={tree?.folders ?? []} isAdmin={isAdmin} onChanged={() => void reload(true)} />
        ) : tab === 'rules' ? (
          <Rules data={data} folders={tree?.folders ?? []} isAdmin={isAdmin} patch={patch} />
        ) : (
          <Users folders={tree?.folders ?? []} meId={meId} />
        )}
      </div>
    </>
  );
}

function Toggle({ label, hint, on, onChange, disabled }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start gap-4 p-4">
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted">{hint}</div>
      </div>
      <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${on ? 'bg-accent' : 'bg-line'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${on ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </div>
  );
}

function Inboxes({ data, folders, isAdmin, onChanged }: { data: SettingsData; folders: FolderOpt[]; isAdmin: boolean; onChanged: () => void }) {
  const [label, setLabel] = useState('');
  const [existing, setExisting] = useState('');
  const toast = useToast();
  const send = async (method: string, body: unknown, ok: string) => {
    try {
      await apiSend(method, '/api/inboxes', body);
      toast({ tone: 'ok', title: ok });
      setLabel('');
      setExisting('');
      setTimeout(onChanged, 1500);
      onChanged();
    } catch (e) {
      toast({ tone: 'bad', title: 'Not saved', body: (e as Error).message });
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card divide-y divide-line">
        {data.inboxes.map((i) => (
          <div key={i.folder_id} className="flex items-center gap-3 p-4">
            <IconInbox size={18} className="text-accent" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">{i.label}{i.is_primary && <Badge tone="accent">primary</Badge>}</div>
              <div className="text-xs text-muted">{i.path} · {i.files} file(s)</div>
            </div>
            {isAdmin && data.inboxes.length > 1 && <button className="btn btn-sm btn-ghost" onClick={() => send('DELETE', { folderId: i.folder_id }, `"${i.label}" is no longer an inbox`)}>Remove</button>}
          </div>
        ))}
      </div>
      {isAdmin && (
        <div className="card space-y-4 p-4">
          <div>
            <h3 className="text-sm font-semibold">Add an inbox</h3>
            <p className="mt-0.5 text-xs text-muted">A phone app, a scanner and an accountant can each drop files in their own folder. Every inbox is swept, read and checked the same way, and reconciliation never prunes one.</p>
          </div>
          <Field label="Create a new folder at the top of the drive">
            <div className="flex gap-2">
              <input className="input" placeholder="e.g. Scanner" value={label} onChange={(e) => setLabel(e.target.value)} />
              <button className="btn btn-primary" disabled={label.trim().length < 2} onClick={() => send('POST', { name: label, label }, `Creating inbox "${label}"`)}><IconPlus size={14} />Create</button>
            </div>
          </Field>
          <Field label="Or use a folder that already exists">
            <div className="flex gap-2">
              <FolderSelect folders={folders} value={existing} onChange={setExisting} />
              <button className="btn" disabled={!existing} onClick={() => send('POST', { folderId: existing, label: folders.find((f) => f.id === existing)?.path.split('/').pop() }, 'Inbox added')}>Add</button>
            </div>
          </Field>
        </div>
      )}
    </div>
  );
}

function Rules({ data, folders, isAdmin, patch }: { data: SettingsData; folders: FolderOpt[]; isAdmin: boolean; patch: (b: unknown, ok: string) => Promise<void> }) {
  const [pattern, setPattern] = useState('');
  const [folder, setFolder] = useState('');
  return (
    <div className="card overflow-hidden">
      <p className="border-b border-line px-4 py-3 text-xs text-muted">Keywords that hint at a folder when there is no filing history for a payee yet. A match is worth 70%, so on its own it never crosses the 80% threshold: history always counts for more. Separate alternatives with |.</p>
      <table className="tbl">
        <thead><tr><th>Keywords</th><th>Folder</th><th /></tr></thead>
        <tbody>
          {data.rules.map((r) => (
            <tr key={r.id}>
              <td className="font-mono text-xs">{r.pattern}</td>
              <td>{r.path ?? '(deleted folder)'}</td>
              <td className="text-right">{isAdmin && <button className="btn btn-sm btn-ghost" onClick={() => patch({ deleteRule: r.id }, 'Rule removed')} aria-label="Remove rule"><IconTrash size={13} /></button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {isAdmin && (
        <div className="flex flex-wrap gap-2 border-t border-line p-3">
          <input className="input w-60" placeholder="e.g. bakery supply|yeast" value={pattern} onChange={(e) => setPattern(e.target.value)} />
          <div className="w-72"><FolderSelect folders={folders} value={folder} onChange={setFolder} /></div>
          <button className="btn btn-primary" disabled={!pattern.trim() || !folder} onClick={() => patch({ addRule: { pattern, folderId: folder } }, 'Rule added').then(() => { setPattern(''); setFolder(''); })}><IconPlus size={14} />Add rule</button>
        </div>
      )}
    </div>
  );
}

function Users({ folders, meId }: { folders: FolderOpt[]; meId: number }) {
  const { data, reload } = useApi<{ users: UserRow[] }>('/api/users');
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [nu, setNu] = useState({ name: '', email: '', role: 'member', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const toast = useToast();
  const choosable = folders.filter((f) => f.parentId && !f.locked);

  const save = async (id: number, body: unknown, ok: string) => {
    try {
      await apiSend('PATCH', `/api/users/${id}`, body);
      toast({ tone: 'ok', title: ok });
      setEditing(null);
      await reload(true);
    } catch (e) {
      toast({ tone: 'bad', title: 'Not saved', body: (e as Error).message });
    }
  };
  const create = async () => {
    try {
      await apiSend('POST', '/api/users', nu);
      toast({ tone: 'ok', title: `Added ${nu.name}` });
      setAdding(false);
      setNu({ name: '', email: '', role: 'member', password: '' });
      setErrors({});
      await reload(true);
    } catch (e) {
      setErrors(((e as { details?: Record<string, string> }).details) ?? {});
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <p className="text-xs text-muted">Admins see everything. Members work inside the folders they are given; viewers can only look. Access is checked on every file read, not just in lists.</p>
        <button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}><IconPlus size={13} />Add person</button>
      </div>
      <table className="tbl">
        <thead><tr><th>Person</th><th>Role</th><th>Folders</th><th>Last sign-in</th><th /></tr></thead>
        <tbody>
          {data?.users.map((u) => (
            <tr key={u.id} className={u.disabled ? 'opacity-50' : ''}>
              <td><div className="flex items-center gap-2"><Avatar name={u.name} color={u.avatar_color} size={26} /><div><div className="font-medium">{u.name}</div><div className="text-xs text-muted">{u.email}</div></div></div></td>
              <td>
                <select className="input w-28 py-1" value={u.role} disabled={u.id === meId} onChange={(e) => save(u.id, { role: e.target.value }, `${u.name} is now ${e.target.value}`)}>
                  <option value="admin">Admin</option><option value="member">Member</option><option value="viewer">Viewer</option>
                </select>
              </td>
              <td className="max-w-[280px] text-xs text-muted">{u.role === 'admin' ? 'Everything' : u.scopes.length ? u.scopes.map((s) => s.path).join(', ') : <span className="text-warn">No folders yet</span>}</td>
              <td className="text-xs text-muted">{fmtAgo(u.last_login_at)}</td>
              <td className="whitespace-nowrap text-right">
                {u.role !== 'admin' && <button className="btn btn-sm" onClick={() => { setEditing(u); setScopes(new Set(u.scopes.map((s) => s.id))); }}>Folders</button>}{' '}
                {u.id !== meId && <button className="btn btn-sm btn-ghost" onClick={() => save(u.id, { disabled: !u.disabled }, u.disabled ? `${u.name} can sign in again` : `${u.name} was signed out and disabled`)}>{u.disabled ? 'Enable' : 'Disable'}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={`Folders for ${editing?.name ?? ''}`}
        footer={<><button className="btn" onClick={() => setEditing(null)}>Cancel</button><button className="btn btn-primary" onClick={() => save(editing!.id, { scopeFolderIds: [...scopes] }, 'Access updated')}>Save</button></>}>
        <p className="mb-2 text-xs text-muted">Giving a folder gives everything inside it.</p>
        <ul className="space-y-1">
          {choosable.map((f) => (
            <li key={f.id}><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scopes.has(f.id)} onChange={() => { const n = new Set(scopes); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); setScopes(n); }} />{f.path}{f.inbox && <Badge tone="accent">inbox</Badge>}</label></li>
          ))}
        </ul>
      </Modal>
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a person"
        footer={<><button className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn btn-primary" onClick={create}>Add</button></>}>
        <div className="space-y-3">
          <Field label="Name" error={errors.name}><input className="input" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} /></Field>
          <Field label="Email" error={errors.email}><input className="input" type="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} /></Field>
          <Field label="Role" error={errors.role}>
            <select className="input" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}><option value="member">Member</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select>
          </Field>
          <Field label="Temporary password" error={errors.password} hint="At least 10 characters; they can change it on their profile."><input className="input" type="password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  );
}
