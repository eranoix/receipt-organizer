import { api } from '@/lib/server/api';
import { logDetail } from '@/lib/server/logs';

export const GET = api<{ uid: string }>({}, async ({ params }) => logDetail(params.uid));
