import { Suspense } from 'react';
import { Files } from '@/components/views/Files';
import { currentUser } from '@/lib/server/auth';

export const metadata = { title: 'Files' };

export default async function Page() {
  const user = await currentUser();
  return <Suspense><Files canWrite={user?.role !== 'viewer'} /></Suspense>;
}
