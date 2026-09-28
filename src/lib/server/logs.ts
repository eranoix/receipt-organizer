import { q, q1 } from '../db';
import { drive } from '../drive';
import type { SessionUser } from './auth';
import { HttpError } from './http-error';
import { logEvent } from './events';
import { workerlessQueue } from './queue-admin';

export interface LogQuery {
  sources?: string[];
  levels?: string[];
  state?: 'open' | 'handled' | 'info' | 'problems' | 'all';
  q?: string;
  trace?: string;
  subject?: string;
  page?: number;
  pageSize?: number;
}

const SOURCES = ['audit', 'sync', 'ocr', 'dedup', 'queue', 'payment', 'system'];

function where(f: LogQuery, skip: 'state' | 'source' | null) {
  const cond: string[] = [];
  const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => { vals.push(v); cond.push(sql.replace('?', `$${vals.length}`)); };
  if (skip !== 'source' && f.sources?.length) add('l.source = ANY(?)', f.sources.filter((s) => SOURCES.includes(s)));
  if (f.levels?.length) add('l.level = ANY(?)', f.levels);
  if (skip !== 'state' && f.state && f.state !== 'all') {
    if (f.state === 'problems') cond.push(`l.state IN ('open', 'handled')`);
    else add('l.state = ?', f.state);
  }
  if (f.trace) add('l.trace_id = ?', f.trace);
  if (f.subject) add('l.subject_id = ?', f.subject);
  if (f.q) {
    vals.push(`%${f.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const n = vals.length;
    cond.push(`(l.message ILIKE $${n} OR l.action ILIKE $${n} OR d.name ILIKE $${n} OR l.trace_id ILIKE $${n})`);
  }
  return { sql: cond.length ? `WHERE ${cond.join(' AND ')}` : '', vals };
}

export async function queryLogs(f: LogQuery) {
  const pageSize = Math.min(100, Math.max(10, f.pageSize ?? 25));
  const page = Math.max(1, f.page ?? 1);
  const w = where(f, null);
  const from = 'FROM ops_log l LEFT JOIN drive_items d ON d.id = l.subject_id';
  const rows = await q(
    `SELECT l.uid, l.source, l.level, l.action, l.message, l.subject_id, d.name AS subject_name, l.trace_id, l.created_at, l.state, l.detail, l.actor
       ${from} ${w.sql} ORDER BY l.created_at DESC, l.uid DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, w.vals);
  const total = (await q1<{ n: number }>(`SELECT count(*) AS n ${from} ${w.sql}`, w.vals))!.n;
  const ws = where(f, 'state');
  const byState = await q<{ state: string; n: number }>(`SELECT l.state, count(*) AS n ${from} ${ws.sql} GROUP BY 1`, ws.vals);
  const wo = where(f, 'source');
  const bySource = await q<{ source: string; n: number }>(`SELECT l.source, count(*) AS n ${from} ${wo.sql} GROUP BY 1`, wo.vals);
  return {
    rows, total, page, pageSize,
    counts: {
      state: Object.fromEntries(byState.map((r) => [r.state, r.n])),
      source: Object.fromEntries(bySource.map((r) => [r.source, r.n])),
    },
  };
}

export async function logDetail(uid: string) {
  const row = await q1(`SELECT l.*, d.name AS subject_name, d.path AS subject_path FROM ops_log l LEFT JOIN drive_items d ON d.id = l.subject_id WHERE l.uid = $1`, [uid]);
  if (!row) throw new HttpError(404, 'Log entry not found');
  let attempts: unknown[] = [];
  if (uid.startsWith('op-')) {
    attempts = await q(`SELECT attempt_number, outcome, error, error_code, duration_ms, started_at FROM operation_attempts WHERE operation_id = $1 ORDER BY id`, [Number(uid.slice(3))]);
  }
  const related = row.trace_id
    ? await q(`SELECT uid, source, level, action, message, created_at, state FROM ops_log WHERE trace_id = $1 ORDER BY created_at, uid LIMIT 50`, [row.trace_id])
    : [];
  return { row, attempts, related };
}

export type LogAction = 'replay' | 'replay_renamed' | 'discard' | 'retry' | 'handle';

async function freeName(parentId: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await drive().childByName(parentId, candidate))) return candidate;
  }
  throw new HttpError(409, 'Could not find a free name');
}

export async function applyLogAction(uid: string, action: LogAction, user: SessionUser, traceId: string): Promise<string> {
  const [kind, idStr] = [uid.slice(0, uid.indexOf('-')), uid.slice(uid.indexOf('-') + 1)];
  const id = Number(idStr);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Bad log id');

  if (kind === 'op') {
    if (user.role !== 'admin') throw new HttpError(403, 'Only admins can replay or discard operations');
    const queue = workerlessQueue();
    const op = await q1<{ kind: string; status: string; last_error_code: string | null; payload: Record<string, unknown> }>('SELECT kind, status, last_error_code, payload FROM operations WHERE id = $1', [id]);
    if (!op) throw new HttpError(404, 'Operation not found');
    if (action === 'discard') {
      if (!(await queue.discard(id))) throw new HttpError(409, 'Only dead operations can be discarded');
      await logEvent({ source: 'audit', action: 'dlq.discard', actorId: user.id, traceId, message: `${user.name} discarded operation #${id} (${op.kind})` });
      return 'discarded';
    }
    if (action === 'replay' || action === 'replay_renamed') {
      let patch: Record<string, unknown> | undefined;
      if (action === 'replay_renamed') {
        const parent = String(op.payload.targetParentId ?? op.payload.parentId ?? '');
        if (!parent || !op.payload.name) throw new HttpError(400, 'This operation has no name to change');
        patch = { name: await freeName(parent, String(op.payload.name)) };
      }
      if (!(await queue.replay(id, patch))) throw new HttpError(409, 'Only dead or discarded operations can be replayed');
      await logEvent({ source: 'audit', action: 'dlq.replay', actorId: user.id, traceId, message: `${user.name} replayed operation #${id} (${op.kind})${patch ? ` as "${patch.name}"` : ''}` });
      return 'replayed';
    }
  }

  if (kind === 'ocr') {
    const run = await q1<{ file_id: string }>('SELECT file_id FROM extraction_runs WHERE id = $1', [id]);
    if (!run) throw new HttpError(404, 'Run not found');
    if (action === 'retry') {
      await q(`UPDATE receipts SET ocr_state = 'queued', ocr_next_at = NULL, ocr_attempts = 0 WHERE file_id = $1 AND ocr_state IN ('failed', 'done')`, [run.file_id]);
      await q('UPDATE extraction_runs SET handled_at = now() WHERE id = $1', [id]);
      return 'queued';
    }
    if (action === 'handle') {
      await q('UPDATE extraction_runs SET handled_at = now() WHERE id = $1', [id]);
      return 'handled';
    }
  }

  if (kind === 'ev' && action === 'handle') {
    await q('UPDATE events SET handled_at = now(), handled_by = $2 WHERE id = $1 AND handled_at IS NULL', [id, user.id]);
    return 'handled';
  }
  throw new HttpError(400, `"${action}" does not apply to this entry`);
}

export async function applyBulk(uids: string[], action: LogAction, user: SessionUser, traceId: string) {
  const list = [...new Set(uids)].slice(0, 200);
  const job = await q1<{ id: number }>(`INSERT INTO jobs (kind, status, total, payload, trace_id, created_by, started_at) VALUES ('bulk_remediate', 'running', $1, $2, $3, $4, now()) RETURNING id`,
    [list.length, JSON.stringify({ action, uids: list }), traceId, user.id]);
  const results: { uid: string; ok: boolean; result: string }[] = [];
  for (const uid of list) {
    try {
      results.push({ uid, ok: true, result: await applyLogAction(uid, action, user, traceId) });
    } catch (err) {
      results.push({ uid, ok: false, result: err instanceof Error ? err.message : String(err) });
    }
  }
  const done = results.filter((r) => r.ok).length;
  await q(`UPDATE jobs SET status = 'done', done = $2, failed = $3, result = $4, finished_at = now() WHERE id = $1`,
    [job!.id, done, list.length - done, JSON.stringify(results)]);
  return { jobId: job!.id, done, failed: list.length - done, results };
}
