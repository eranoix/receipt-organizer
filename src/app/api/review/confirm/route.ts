import { api, HttpError, readJson } from '@/lib/server/api';
import { confirmFiling } from '@/lib/server/receipts';

export const POST = api({}, async ({ req, user, traceId }) => {
  const b = await readJson<{ items?: { fileId: string; folderId?: string | null }[] }>(req);
  if (!Array.isArray(b.items) || b.items.length === 0) throw new HttpError(400, 'Nothing to confirm');
  return { ...(await confirmFiling(b.items, user, traceId)), traceId };
});
