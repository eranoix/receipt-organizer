import { api, HttpError, readJson } from '@/lib/server/api';
import { applyBulk, applyLogAction, type LogAction } from '@/lib/server/logs';

const ACTIONS: LogAction[] = ['replay', 'replay_renamed', 'discard', 'retry', 'handle'];

export const POST = api({}, async ({ req, user, traceId }) => {
  const b = await readJson<{ uids?: string[]; action?: LogAction }>(req);
  if (!b.action || !ACTIONS.includes(b.action)) throw new HttpError(400, 'Unknown action');
  const uids = (b.uids ?? []).filter((u) => typeof u === 'string');
  if (uids.length === 0) throw new HttpError(400, 'Select at least one entry');
  if (uids.length === 1) return { done: 1, failed: 0, results: [{ uid: uids[0], ok: true, result: await applyLogAction(uids[0], b.action, user, traceId) }] };
  return applyBulk(uids, b.action, user, traceId);
});
