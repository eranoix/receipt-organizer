import { api } from '@/lib/server/api';
import { reviewList } from '@/lib/server/receipts';

export const GET = api({}, async ({ req, user }) => {
  const sp = req.nextUrl.searchParams;
  return reviewList(user, { stage: sp.get('stage') ?? undefined, inbox: sp.get('inbox') ?? undefined, q: sp.get('q')?.slice(0, 80) ?? undefined });
});
