import { Suspense } from 'react';
import { Review } from '@/components/views/Review';
import { currentUser } from '@/lib/server/auth';

export const metadata = { title: 'Review' };

export default async function Page() {
  const user = await currentUser();
  return <Suspense><Review canWrite={user?.role !== 'viewer'} /></Suspense>;
}
