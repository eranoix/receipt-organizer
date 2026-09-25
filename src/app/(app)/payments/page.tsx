import { Suspense } from 'react';
import { Payments } from '@/components/views/Payments';
import { currentUser } from '@/lib/server/auth';

export const metadata = { title: 'Payments' };

export default async function Page() {
  const user = await currentUser();
  return <Suspense><Payments canWrite={user?.role !== 'viewer'} /></Suspense>;
}
