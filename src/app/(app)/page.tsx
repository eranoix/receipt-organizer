import { Dashboard } from '@/components/views/Dashboard';
import { currentUser } from '@/lib/server/auth';

export default async function Page() {
  const user = await currentUser();
  return <Dashboard firstName={user?.name.split(' ')[0] ?? 'there'} />;
}
