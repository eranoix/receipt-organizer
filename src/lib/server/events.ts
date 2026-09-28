import { q, type Db } from '../db';

export type EventSource = 'audit' | 'sync' | 'ocr' | 'dedup' | 'queue' | 'payment' | 'system';

export interface EventInput {
  source: EventSource;
  level?: 'info' | 'warn' | 'error';
  action: string;
  message: string;
  subjectId?: string | null;
  actorId?: number | null;
  traceId?: string | null;
  data?: Record<string, unknown>;
  handled?: boolean;
}

export async function logEvent(e: EventInput, db?: Db): Promise<void> {
  await q(
    `INSERT INTO events (source, level, action, message, subject_id, actor_id, trace_id, data, handled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9 THEN now() END)`,
    [e.source, e.level ?? 'info', e.action, e.message, e.subjectId ?? null, e.actorId ?? null, e.traceId ?? null, JSON.stringify(e.data ?? {}), !!e.handled],
    db,
  );
}

type Pref = 'notify_dlq' | 'notify_duplicates' | 'notify_bills';

export async function notify(opts: { roles: ('admin' | 'member' | 'viewer')[]; pref?: Pref; kind: string; title: string; body?: string; link?: string }, db?: Db): Promise<void> {
  await q(
    `INSERT INTO notifications (user_id, kind, title, body, link)
     SELECT id, $2, $3, $4, $5 FROM users
      WHERE role = ANY($1) AND NOT disabled ${opts.pref ? `AND ${opts.pref}` : ''}`,
    [opts.roles, opts.kind, opts.title, opts.body ?? '', opts.link ?? null],
    db,
  );
}

export async function resolveDuplicateWarning(fileId: string, db?: Db): Promise<void> {
  await q(`UPDATE events SET handled_at = now() WHERE action = 'duplicate.suspected' AND subject_id = $1 AND handled_at IS NULL`, [fileId], db);
}
