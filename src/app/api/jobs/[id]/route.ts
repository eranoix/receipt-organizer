import { q1 } from '@/lib/db';
import { api, HttpError } from '@/lib/server/api';

export const GET = api<{ id: string }>({}, async ({ params }) => {
  const job = await q1(`SELECT id, kind, status, total, done, failed, result, created_at, started_at, finished_at, trace_id FROM jobs WHERE id = $1`, [Number(params.id)]);
  if (!job) throw new HttpError(404, 'Job not found');
  return job;
});
