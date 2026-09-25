import { api, intParam } from '@/lib/server/api';
import { queryLogs, type LogQuery } from '@/lib/server/logs';

export const GET = api({}, async ({ req }) => {
  const sp = req.nextUrl.searchParams;
  const list = (k: string) => sp.get(k)?.split(',').map((s) => s.trim()).filter(Boolean);
  return queryLogs({
    sources: list('source'),
    levels: list('level'),
    state: (sp.get('state') as LogQuery['state']) ?? 'all',
    q: sp.get('q')?.slice(0, 80) || undefined,
    trace: sp.get('trace') || undefined,
    subject: sp.get('subject') || undefined,
    page: intParam(sp.get('page'), 1, 1, 10_000),
    pageSize: intParam(sp.get('pageSize'), 25, 10, 100),
  });
});
