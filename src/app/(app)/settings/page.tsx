import { Settings } from '@/components/views/Settings';
import { currentUser } from '@/lib/server/auth';

export const metadata = { title: 'Settings' };

export default async function Page() {
  const user = await currentUser();
  return <Settings isAdmin={user?.role === 'admin'} meId={user?.id ?? 0} />;
}
