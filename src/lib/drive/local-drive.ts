import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DriveError, mimeFor, type DeltaPage, type DriveAdapter, type DriveChange, type DriveErrorCode, type DriveItem } from './types';

interface Meta { parentId: string | null; name: string; isFolder: boolean; size: number; etag: string; modifiedAt: string }
interface State { seq: number; rootId: string; items: Record<string, Meta>; subscriptionExpiresAt: string | null }
interface FeedLine { seq: number; change: DriveChange }

export interface LocalDriveOptions {
  latencyMs?: number;
  now?: () => number;
}

export class LocalDrive implements DriveAdapter {
  readonly kind = 'local' as const;
  private state: State | null = null;
  private stateMtime = 0;
  private chain: Promise<unknown> = Promise.resolve();
  readonly faults = new Map<string, { remaining: number; code: DriveErrorCode }>();

  constructor(readonly root: string, private readonly opts: LocalDriveOptions = {}) {}

  private get metaDir() { return path.join(this.root, '.drive'); }
  private get statePath() { return path.join(this.metaDir, 'state.json'); }
  private get feedPath() { return path.join(this.metaDir, 'changes.jsonl'); }
  private now() { return (this.opts.now ?? Date.now)(); }

  async rootId() {
    return (await this.load()).rootId;
  }

  async delta(cursor: string | null, signal?: AbortSignal): Promise<DeltaPage> {
    return this.exclusive(async () => {
      await this.pause(signal);
      await this.scan();
      const s = await this.load();
      const from = cursor ? Number(cursor) : NaN;
      if (!Number.isFinite(from)) {
        const changes: DriveChange[] = Object.keys(s.items).map((id) => ({ type: 'upsert', item: this.toItem(id, s) }));
        return { changes, cursor: String(s.seq), reset: true };
      }
      const lines = await this.readFeed();
      const latest = new Map<string, DriveChange>();
      for (const l of lines) {
        if (l.seq <= from) continue;
        const id = l.change.type === 'delete' ? l.change.id : l.change.item.id;
        latest.set(id, l.change);
      }
      const changes = [...latest.values()].map((c) => (c.type === 'upsert' && s.items[c.item.id] ? { type: 'upsert' as const, item: this.toItem(c.item.id, s) } : c));
      return { changes, cursor: String(s.seq), reset: false };
    });
  }

  async listAll(signal?: AbortSignal): Promise<DriveItem[]> {
    return this.exclusive(async () => {
      await this.pause(signal);
      await this.scan();
      const s = await this.load();
      return Object.keys(s.items).map((id) => this.toItem(id, s));
    });
  }

  async get(id: string, signal?: AbortSignal) {
    await this.pause(signal);
    const s = await this.load(true);
    return s.items[id] ? this.toItem(id, s) : null;
  }

  async childByName(parentId: string, name: string, signal?: AbortSignal) {
    await this.pause(signal);
    const s = await this.load(true);
    const id = this.findChild(s, parentId, name);
    return id ? this.toItem(id, s) : null;
  }

  async read(id: string, signal?: AbortSignal) {
    await this.pause(signal);
    const s = await this.load(true);
    if (!s.items[id] || s.items[id].isFolder) throw new DriveError('itemNotFound', `file ${id} not found`, 404);
    return fs.readFile(this.abs(id, s));
  }

  async createFolder(parentId: string, name: string, signal?: AbortSignal) {
    return this.mutate('createFolder', signal, async (s) => {
      this.assertFolder(s, parentId);
      this.assertName(name);
      if (this.findChild(s, parentId, name)) throw new DriveError('nameAlreadyExists', `"${name}" already exists here`, 409);
      const id = this.newId();
      s.items[id] = { parentId, name, isFolder: true, size: 0, etag: this.etag(), modifiedAt: new Date(this.now()).toISOString() };
      await fs.mkdir(this.abs(id, s), { recursive: true });
      return id;
    });
  }

  async move(id: string, parentId: string, name: string, signal?: AbortSignal) {
    return this.mutate('move', signal, async (s) => {
      const it = s.items[id];
      if (!it || id === s.rootId) throw new DriveError('itemNotFound', `item ${id} not found`, 404);
      this.assertFolder(s, parentId);
      this.assertName(name);
      if (it.isFolder && this.isDescendant(s, parentId, id)) throw new DriveError('invalidRequest', 'cannot move a folder into itself', 400);
      const clash = this.findChild(s, parentId, name);
      if (clash && clash !== id) throw new DriveError('nameAlreadyExists', `"${name}" already exists in the destination`, 409);
      const from = this.abs(id, s);
      it.parentId = parentId;
      it.name = name;
      it.etag = this.etag();
      it.modifiedAt = new Date(this.now()).toISOString();
      await fs.rename(from, this.abs(id, s));
      return id;
    }, (s, id) => this.subtree(s, id));
  }

  async delete(id: string, signal?: AbortSignal) {
    await this.mutate('delete', signal, async (s) => {
      if (!s.items[id] || id === s.rootId) throw new DriveError('itemNotFound', `item ${id} not found`, 404);
      await fs.rm(this.abs(id, s), { recursive: true, force: true });
      return id;
    });
  }

  async upload(parentId: string, name: string, bytes: Buffer, signal?: AbortSignal) {
    return this.mutate('upload', signal, async (s) => {
      this.assertFolder(s, parentId);
      this.assertName(name);
      if (this.findChild(s, parentId, name)) throw new DriveError('nameAlreadyExists', `"${name}" already exists here`, 409);
      const id = this.newId();
      s.items[id] = { parentId, name, isFolder: false, size: bytes.length, etag: this.etag(), modifiedAt: new Date(this.now()).toISOString() };
      await fs.writeFile(this.abs(id, s), bytes);
      return id;
    });
  }

  async subscribe(signal?: AbortSignal) {
    return this.exclusive(async () => {
      await this.pause(signal);
      this.inject('subscribe');
      const s = await this.load();
      s.subscriptionExpiresAt = new Date(this.now() + 3 * 24 * 3600_000).toISOString();
      await this.saveState(s);
      return { expiresAt: s.subscriptionExpiresAt };
    });
  }


  private mutate(op: string, signal: AbortSignal | undefined, fn: (s: State) => Promise<string>, affected?: (s: State, id: string) => string[]): Promise<DriveItem> {
    return this.exclusive(async () => {
      await this.pause(signal);
      this.inject(op);
      signal?.throwIfAborted();
      const s = await this.load();
      const id = await fn(s);
      const changes: DriveChange[] = [];
      if (op === 'delete') {
        for (const d of this.subtree(s, id)) {
          delete s.items[d];
          changes.push({ type: 'delete', id: d });
        }
      } else {
        for (const a of affected ? affected(s, id) : [id]) changes.push({ type: 'upsert', item: this.toItem(a, s) });
      }
      await this.appendFeed(s, changes);
      await this.saveState(s);
      return op === 'delete' ? ({ id } as DriveItem) : this.toItem(id, s);
    });
  }

  private inject(op: string) {
    const f = this.faults.get(op);
    if (f && f.remaining > 0) {
      f.remaining -= 1;
      const status = f.code === 'throttled' ? 429 : f.code === 'nameAlreadyExists' ? 409 : f.code === 'itemNotFound' ? 404 : 503;
      throw new DriveError(f.code, `injected fault: ${f.code}`, status, f.code === 'throttled' ? 50 : undefined);
    }
  }

  private async pause(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const ms = this.opts.latencyMs ?? 0;
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new DOMException('aborted', 'AbortError')); }, { once: true });
    });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async load(fresh = false): Promise<State> {
    if (this.state && !fresh) return this.state;
    try {
      const st = await fs.stat(this.statePath);
      if (this.state && st.mtimeMs === this.stateMtime) return this.state;
      this.state = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as State;
      this.stateMtime = st.mtimeMs;
      return this.state;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await fs.mkdir(this.metaDir, { recursive: true });
      const rootId = this.newId();
      this.state = { seq: 0, rootId, items: { [rootId]: { parentId: null, name: '', isFolder: true, size: 0, etag: this.etag(), modifiedAt: new Date(this.now()).toISOString() } }, subscriptionExpiresAt: null };
      await this.saveState(this.state);
      return this.state;
    }
  }

  private async saveState(s: State) {
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s));
    await fs.rename(tmp, this.statePath);
    this.stateMtime = (await fs.stat(this.statePath)).mtimeMs;
    this.state = s;
  }

  private async appendFeed(s: State, changes: DriveChange[]) {
    if (changes.length === 0) return;
    const lines = changes.map((change) => {
      s.seq += 1;
      return JSON.stringify({ seq: s.seq, change } satisfies FeedLine);
    });
    await fs.appendFile(this.feedPath, lines.join('\n') + '\n');
  }

  private async readFeed(): Promise<FeedLine[]> {
    try {
      const txt = await fs.readFile(this.feedPath, 'utf8');
      return txt.split('\n').filter(Boolean).map((l) => JSON.parse(l) as FeedLine);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private async scan() {
    const s = await this.load(true);
    const byPath = new Map<string, string>();
    for (const id of Object.keys(s.items)) byPath.set(this.rel(id, s), id);
    const seen = new Set<string>([s.rootId]);
    const changes: DriveChange[] = [];

    const walk = async (dirId: string, dirAbs: string) => {
      let entries: import('node:fs').Dirent[] = [];
      try { entries = await fs.readdir(dirAbs, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(dirAbs, e.name);
        const rel = path.relative(this.root, abs);
        let id = byPath.get(rel);
        const st = await fs.stat(abs);
        if (!id) {
          id = this.newId();
          s.items[id] = { parentId: dirId, name: e.name, isFolder: e.isDirectory(), size: e.isDirectory() ? 0 : st.size, etag: `${st.mtimeMs}:${st.size}`, modifiedAt: st.mtime.toISOString() };
          changes.push({ type: 'upsert', item: this.toItem(id, s) });
        } else if (!e.isDirectory() && s.items[id].size !== st.size) {
          Object.assign(s.items[id], { size: st.size, etag: `${st.mtimeMs}:${st.size}`, modifiedAt: st.mtime.toISOString() });
          changes.push({ type: 'upsert', item: this.toItem(id, s) });
        }
        seen.add(id);
        if (e.isDirectory()) await walk(id, abs);
      }
    };
    await walk(s.rootId, this.root);

    for (const id of Object.keys(s.items)) {
      if (!seen.has(id)) {
        delete s.items[id];
        changes.push({ type: 'delete', id });
      }
    }
    if (changes.length) {
      await this.appendFeed(s, changes);
      await this.saveState(s);
    }
  }

  private toItem(id: string, s: State): DriveItem {
    const m = s.items[id];
    return { id, parentId: m.parentId, name: m.name, isFolder: m.isFolder, size: m.size, mime: m.isFolder ? null : mimeFor(m.name), etag: m.etag, modifiedAt: m.modifiedAt };
  }

  private rel(id: string, s: State): string {
    const parts: string[] = [];
    let cur: string | null = id;
    let guard = 0;
    while (cur && cur !== s.rootId && s.items[cur] && guard++ < 100) {
      parts.unshift(s.items[cur].name);
      cur = s.items[cur].parentId;
    }
    return parts.join(path.sep);
  }

  private abs(id: string, s: State) {
    return path.join(this.root, this.rel(id, s));
  }

  private findChild(s: State, parentId: string, name: string): string | null {
    const lower = name.toLowerCase();
    for (const [id, m] of Object.entries(s.items)) if (m.parentId === parentId && m.name.toLowerCase() === lower) return id;
    return null;
  }

  private subtree(s: State, id: string): string[] {
    const out = [id];
    for (let i = 0; i < out.length; i += 1) {
      for (const [cid, m] of Object.entries(s.items)) if (m.parentId === out[i]) out.push(cid);
    }
    return out;
  }

  private isDescendant(s: State, maybeChild: string, ancestor: string): boolean {
    let cur: string | null = maybeChild;
    while (cur) {
      if (cur === ancestor) return true;
      cur = s.items[cur]?.parentId ?? null;
    }
    return false;
  }

  private assertFolder(s: State, id: string) {
    if (!s.items[id]?.isFolder) throw new DriveError('itemNotFound', `folder ${id} not found`, 404);
  }

  private assertName(name: string) {
    if (!name || name.length > 200 || /[\\/:*?"<>|]/.test(name) || name.startsWith('.')) {
      throw new DriveError('invalidRequest', `invalid name "${name}"`, 400);
    }
  }

  private newId() { return `loc_${randomBytes(6).toString('hex')}`; }
  private etag() { return `e${this.now().toString(36)}${randomBytes(2).toString('hex')}`; }
}
