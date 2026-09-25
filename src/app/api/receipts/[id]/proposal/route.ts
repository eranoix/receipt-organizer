import { api, readJson } from '@/lib/server/api';
import { decideProposal } from '@/lib/server/receipts';

export const POST = api<{ id: string }>({}, async ({ req, user, params, traceId }) => {
  const b = await readJson<{ accept?: boolean; fields?: string[] }>(req);
  return decideProposal(params.id, !!b.accept, Array.isArray(b.fields) ? b.fields : undefined, user, traceId);
});
