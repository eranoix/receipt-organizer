import { api } from '@/lib/server/api';
import { reprocessOne } from '@/lib/server/receipts';

export const POST = api<{ id: string }>({}, async ({ user, params, traceId }) => reprocessOne(params.id, user, traceId));
