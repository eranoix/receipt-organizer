import { Bills } from '@/components/views/Bills';
import { currentUser } from '@/lib/server/auth';

export const metadata = { title: 'Bills' };

export default async function Page() {
  const user = await currentUser();
  return <Bills canWrite={user?.role !== 'viewer'} />;
}
