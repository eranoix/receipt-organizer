export interface ListedItem {
  id: string;
  parentId: string | null;
  name: string;
  isFolder: boolean;
  size: number;
}

export interface PendingOp {
  id: number;
  kind: string;
  status: 'pending' | 'running' | 'dead';
  attempts: number;
  lastError: string | null;
  payload: {
    itemId?: string; targetParentId?: string; name?: string; parentId?: string; intent?: string;
    snapshot?: { name: string; isFolder: boolean; size: number };
  };
}

export type OverlayBadge = { label: string; tone: 'pending' | 'failed'; opId: number; detail?: string | null };
export type Overlaid<T> = T & { pending?: OverlayBadge; ghost?: boolean };

const verbs: Record<string, string> = {
  classify: 'Filing', move: 'Moving', rename: 'Renaming', delete: 'Deleting', createFolder: 'Creating', upload: 'Uploading',
};

function label(op: PendingOp): string {
  const intent = op.payload.intent ?? op.kind.replace('drive.', '');
  const verb = verbs[intent] ?? 'Updating';
  return op.attempts > 0 ? `${verb} (retry ${op.attempts})` : `${verb}...`;
}

export function applyOverlay<T extends ListedItem>(items: T[], ops: PendingOp[], folderId: string, makeGhost: (o: PendingOp) => T): Overlaid<T>[] {
  const out = new Map<string, Overlaid<T>>(items.map((i) => [i.id, { ...i }]));
  const ghosts: Overlaid<T>[] = [];

  for (const op of [...ops].sort((a, b) => a.id - b.id)) {
    const p = op.payload;
    if (op.status === 'dead') {
      const target = p.itemId ? out.get(p.itemId) : undefined;
      if (target) target.pending = { label: 'Failed', tone: 'failed', opId: op.id, detail: op.lastError };
      continue;
    }
    const badge: OverlayBadge = { label: label(op), tone: 'pending', opId: op.id };

    if (op.kind === 'drive.move' && p.itemId) {
      const here = out.get(p.itemId);
      if (here && p.targetParentId !== folderId) {
        out.delete(p.itemId);
      } else if (here) {
        here.name = p.name ?? here.name;
        here.pending = badge;
      } else if (p.targetParentId === folderId && p.snapshot) {
        ghosts.push({ ...makeGhost(op), id: p.itemId, name: p.name ?? p.snapshot.name, pending: badge, ghost: true });
      }
    } else if (op.kind === 'drive.delete' && p.itemId) {
      const here = out.get(p.itemId);
      if (here) here.pending = { ...badge, label: 'Deleting...' };
    } else if ((op.kind === 'drive.createFolder' || op.kind === 'drive.upload') && p.parentId === folderId && p.name) {
      const exists = [...out.values()].some((i) => i.name.toLowerCase() === p.name!.toLowerCase());
      if (!exists) ghosts.push({ ...makeGhost(op), pending: badge, ghost: true });
    }
  }
  return [...out.values(), ...ghosts];
}
