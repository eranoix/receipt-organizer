import { api, readJson } from '@/lib/server/api';
import { receiptDetail, updateFields } from '@/lib/server/receipts';

export const GET = api<{ id: string }>({}, async ({ user, params }) => receiptDetail(params.id, user));

export const PATCH = api<{ id: string }>({}, async ({ req, user, params, traceId }) => {
  const b = await readJson<Record<string, unknown>>(req);
  return updateFields(params.id, b, user, traceId);
});
