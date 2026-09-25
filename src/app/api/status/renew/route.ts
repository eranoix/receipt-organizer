import { api } from '@/lib/server/api';
import { logEvent } from '@/lib/server/events';
import { enqueue } from '@/lib/server/queue';

/**
 * "Renew now" actually renews: it queues the subscription call instead of
 * only navigating somewhere, and the status page polls until the new expiry
 * shows up.
 */
export const POST = api({ role: 'admin', limit: ['renew', 5, 60_000] }, async ({ user, traceId }) => {
  const { op } = await enqueue({ kind: 'drive.subscribe', idempotencyKey: `subscribe:manual:${traceId}`, traceId, createdBy: user.id, payload: { intent: 'subscribe' } });
  await logEvent({ source: 'audit', action: 'sync.renew_requested', actorId: user.id, traceId, message: `${user.name} asked to renew the change subscription` });
  return { operationId: op.id };
});
