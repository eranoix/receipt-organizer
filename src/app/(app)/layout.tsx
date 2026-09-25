import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { currentUser } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');
  return (
    <AppShell user={{ id: user.id, name: user.name, role: user.role, avatarColor: user.avatarColor, theme: user.theme, email: user.email }}>
      {children}
    </AppShell>
  );
}
