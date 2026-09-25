import { Suspense } from 'react';
import { Operations } from '@/components/views/Operations';
import { currentUser } from '@/lib/server/auth';

export const metadata = { title: 'Operations' };

export default async function Page() {
  const user = await currentUser();
  return <Suspense><Operations isAdmin={user?.role === 'admin'} /></Suspense>;
}
