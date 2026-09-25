import { q1 } from '@/lib/db';
import { api } from '@/lib/server/api';
import { systemStatus } from '@/lib/server/status';

/** Small, frequent: sidebar counters, unread notifications and the health dot. */
export const GET = api({}, async ({ user }) => {
  const c = await q1<{ waiting: number; duplicates: number; open: number; unread: number; bills: number }>(
    `SELECT (SELECT count(*) FROM receipt_view WHERE in_inbox AND stage IN ('suggested', 'needs_decision', 'unreadable')) AS waiting,
            (SELECT count(*) FROM duplicate_candidates WHERE status IN ('suspected', 'proven')) AS duplicates,
            (SELECT count(*) FROM ops_log WHERE state = 'open') AS open,
            (SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL) AS unread,
            (SELECT count(*) FROM bill_occurrences WHERE status = 'open' AND due_date < current_date) AS bills`, [user.id]);
  const status = await systemStatus(false);
  return { ...c, level: status.level, headline: status.headline };
});
