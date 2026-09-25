import { q, q1 } from '@/lib/db';
import { api } from '@/lib/server/api';

export const GET = api({}, async () => {
  const stages = await q<{ stage: string; n: number }>(`SELECT stage, count(*) AS n FROM receipt_view WHERE in_inbox OR stage = 'duplicate' GROUP BY 1`);
  const dead = await q1<{ n: number }>(`SELECT count(*) AS n FROM operations WHERE status = 'dead'`);
  const inflight = await q1<{ n: number }>(`SELECT count(*) AS n FROM operations WHERE status IN ('pending', 'running')`);
  const bills = await q(
    `SELECT o.id, o.due_date, o.expected_cents, o.status, b.name, b.payee FROM bill_occurrences o JOIN bills b ON b.id = o.bill_id
      WHERE o.status = 'open' AND o.due_date <= current_date + 14 ORDER BY o.due_date LIMIT 6`);
  const month = await q1<{ paid: number; paid_cents: number; open: number }>(
    `SELECT count(*) FILTER (WHERE status = 'paid') AS paid, coalesce(sum(expected_cents) FILTER (WHERE status = 'paid'), 0) AS paid_cents,
            count(*) FILTER (WHERE status = 'open') AS open
       FROM bill_occurrences WHERE date_trunc('month', due_date) = date_trunc('month', current_date)`);
  const filedWeek = await q1<{ n: number }>(`SELECT count(*) AS n FROM receipts WHERE classified_at > now() - interval '7 days'`);
  const activity = await q(
    `SELECT uid, source, level, message, created_at, state, actor FROM ops_log WHERE source <> 'queue' OR state = 'open' ORDER BY created_at DESC LIMIT 12`);
  const inboxes = await q(
    `SELECT ib.folder_id, ib.label, count(rv.file_id) FILTER (WHERE rv.stage IN ('suggested', 'needs_decision', 'unreadable', 'reading')) AS waiting
       FROM inbox_folders ib LEFT JOIN receipt_view rv ON rv.parent_id = ib.folder_id GROUP BY 1, 2 ORDER BY 2`);
  const sync = await q1(`SELECT last_delta_at, last_full_at, lock_owner, last_error FROM sync_state WHERE name = 'drive'`);
  return {
    stages: Object.fromEntries(stages.map((s) => [s.stage, s.n])),
    dead: dead?.n ?? 0, inflight: inflight?.n ?? 0, bills, month, filedWeek: filedWeek?.n ?? 0, activity, inboxes, sync,
  };
});
