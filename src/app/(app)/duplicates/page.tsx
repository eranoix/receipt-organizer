import { Duplicates } from '@/components/views/Duplicates';
import { currentUser } from '@/lib/server/auth';

export const metadata = { title: 'Duplicates' };

export default async function Page() {
  const user = await currentUser();
  return <Duplicates isAdmin={user?.role === 'admin'} canWrite={user?.role !== 'viewer'} />;
}
