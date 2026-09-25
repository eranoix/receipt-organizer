'use client';

export interface FolderOpt { id: string; path: string; inbox: string | null; locked: boolean; parentId: string | null }

/** Folder picker listing real destinations only: no root, no inboxes, nothing out of scope. */
export function FolderSelect({ folders, value, onChange, placeholder = 'Choose a folder...' }: { folders: FolderOpt[]; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const opts = folders.filter((f) => f.parentId && !f.inbox && !f.locked);
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {opts.map((f) => (
        <option key={f.id} value={f.id}>{f.path}</option>
      ))}
    </select>
  );
}
