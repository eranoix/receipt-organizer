import { api, readJson } from '@/lib/server/api';
import { createReprocessJob } from '@/lib/server/jobs';

export const POST = api({ limit: ['bulk', 10, 60_000] }, async ({ req, user, traceId }) => {
  const b = await readJson<{ fileIds?: string[] }>(req);
  return createReprocessJob(Array.isArray(b.fileIds) ? b.fileIds : [], user, traceId);
});
