import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDrive } from '@/lib/drive/local-drive';
import { DriveError } from '@/lib/drive/types';

let dir: string;
let drive: LocalDrive;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ro-drive-'));
  drive = new LocalDrive(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('LocalDrive', () => {
  it('keeps ids stable across rename and move, and reports them through delta', async () => {
    const root = await drive.rootId();
    const inbox = await drive.createFolder(root, 'Inbox');
    const rent = await drive.createFolder(root, 'Rent');
    const f = await drive.upload(inbox.id, 'a.pdf', Buffer.from('%PDF-demo'));
    const first = await drive.delta(null);
    expect(first.reset).toBe(true);

    const moved = await drive.move(f.id, rent.id, 'rent-aug.pdf');
    expect(moved.id).toBe(f.id);
    const page = await drive.delta(first.cursor);
    expect(page.changes).toEqual([{ type: 'upsert', item: expect.objectContaining({ id: f.id, parentId: rent.id, name: 'rent-aug.pdf' }) }]);
    expect((await drive.read(f.id)).toString()).toBe('%PDF-demo');
  });

  it('refuses to overwrite: a name collision is an error with a code', async () => {
    const root = await drive.rootId();
    await drive.upload(root, 'a.pdf', Buffer.from('1'));
    const err = await drive.upload(root, 'A.PDF', Buffer.from('2')).catch((e) => e);
    expect(err).toBeInstanceOf(DriveError);
    expect(err.code).toBe('nameAlreadyExists');
  });

  it('notices files dropped into the directory by someone else', async () => {
    const root = await drive.rootId();
    const inbox = await drive.createFolder(root, 'Inbox');
    const { cursor } = await drive.delta(null);
    await writeFile(path.join(dir, 'Inbox', 'phone-scan.png'), Buffer.from('png'));
    const page = await drive.delta(cursor);
    expect(page.changes).toHaveLength(1);
    expect(page.changes[0]).toMatchObject({ type: 'upsert', item: { name: 'phone-scan.png', parentId: inbox.id } });
  });

  it('deletes folders with their contents and emits a delete for each', async () => {
    const root = await drive.rootId();
    const folder = await drive.createFolder(root, 'Old');
    await drive.upload(folder.id, 'x.pdf', Buffer.from('x'));
    const { cursor } = await drive.delta(null);
    await drive.delete(folder.id);
    const page = await drive.delta(cursor);
    expect(page.changes.filter((c) => c.type === 'delete')).toHaveLength(2);
    expect(await drive.get(folder.id)).toBeNull();
  });

  it('honours cancellation: an aborted move never lands', async () => {
    const slow = new LocalDrive(dir, { latencyMs: 100 });
    const root = await slow.rootId();
    const a = await slow.createFolder(root, 'A');
    const b = await slow.createFolder(root, 'B');
    const f = await slow.upload(a.id, 'f.pdf', Buffer.from('f'));
    const ctl = new AbortController();
    const p = slow.move(f.id, b.id, 'f.pdf', ctl.signal);
    setTimeout(() => ctl.abort(new DOMException('deadline', 'TimeoutError')), 20);
    await expect(p).rejects.toThrow();
    expect((await slow.get(f.id))?.parentId).toBe(a.id);
  });

  it('injects faults for tests and demos', async () => {
    const root = await drive.rootId();
    drive.faults.set('createFolder', { remaining: 1, code: 'throttled' });
    await expect(drive.createFolder(root, 'X')).rejects.toMatchObject({ code: 'throttled', status: 429 });
    await expect(drive.createFolder(root, 'X')).resolves.toMatchObject({ name: 'X' });
  });

  it('will not move a folder into itself', async () => {
    const root = await drive.rootId();
    const a = await drive.createFolder(root, 'A');
    const inner = await drive.createFolder(a.id, 'Inner');
    await expect(drive.move(a.id, inner.id, 'A')).rejects.toMatchObject({ code: 'invalidRequest' });
  });
});
