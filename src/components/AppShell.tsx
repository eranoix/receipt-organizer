'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { apiSend, fmtAgo, useApi } from './client';
import {
  IconActivity, IconBell, IconCalendar, IconCard, IconCopy, IconFolder, IconGauge, IconHome, IconInbox, IconLogout, IconMoon, IconReceipt, IconSettings, IconSun,
} from './icons';
import { ToastProvider } from './toast';
import { Avatar } from './ui';

export interface ShellUser { id: number; name: string; role: 'admin' | 'member' | 'viewer'; avatarColor: string; theme: string; email: string }

interface Shell { waiting: number; duplicates: number; open: number; unread: number; bills: number; level: 'operational' | 'degraded' | 'outage'; headline: string }

const NAV = [
  { href: '/', label: 'Overview', icon: IconHome },
  { href: '/review', label: 'Review', icon: IconInbox, count: 'waiting' as const },
  { href: '/files', label: 'Files', icon: IconFolder },
  { href: '/duplicates', label: 'Duplicates', icon: IconCopy, count: 'duplicates' as const },
  { href: '/bills', label: 'Bills', icon: IconCalendar, count: 'bills' as const, warn: true },
  { href: '/payments', label: 'Payments', icon: IconCard },
  { href: '/operations', label: 'Operations', icon: IconActivity, count: 'open' as const, warn: true },
  { href: '/status', label: 'System status', icon: IconGauge },
  { href: '/settings', label: 'Settings', icon: IconSettings },
];

const DOT = { operational: 'bg-ok', degraded: 'bg-warn', outage: 'bg-bad' };

export function AppShell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { data: shell, reload } = useApi<Shell>('/api/shell', 15_000);
  const [dark, setDark] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);

  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);

  const toggleTheme = async () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    await apiSend('PATCH', '/api/me', { theme: next ? 'dark' : 'light' }).catch(() => undefined);
  };

  const logout = async () => {
    await apiSend('POST', '/api/auth/logout');
    router.push('/login');
  };

  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));

  return (
    <ToastProvider>
      <div className="flex min-h-screen">
        <aside className="sticky top-0 flex h-screen w-16 shrink-0 flex-col border-r border-line bg-panel lg:w-60">
          <Link href="/" className="flex h-14 items-center gap-2.5 border-b border-line px-4">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-ink"><IconReceipt size={18} /></span>
            <span className="hidden lg:block">
              <span className="block text-sm font-semibold leading-4">Tidyslip</span>
              <span className="block text-[11px] text-muted">Juniper Lane Bakery</span>
            </span>
          </Link>
          <nav className="flex-1 space-y-0.5 overflow-y-auto p-2 scroll-thin" aria-label="Main">
            {NAV.map((n) => {
              const count = n.count && shell ? shell[n.count] : 0;
              return (
                <Link key={n.href} href={n.href} title={n.label}
                  className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${active(n.href) ? 'bg-accent/10 font-medium text-accent' : 'text-muted hover:bg-sunken hover:text-ink'}`}>
                  <span className="relative">
                    <n.icon size={18} />
                    {n.href === '/status' && shell && <span className={`absolute -right-1 -top-1 h-2 w-2 rounded-full ring-2 ring-panel ${DOT[shell.level]}`} />}
                  </span>
                  <span className="hidden flex-1 lg:block">{n.label}</span>
                  {count > 0 && (
                    <span className={`hidden rounded-full px-1.5 text-[11px] font-semibold tabular-nums lg:inline ${n.warn ? 'bg-warn/15 text-warn' : 'bg-sunken text-muted'}`}>{count}</span>
                  )}
                </Link>
              );
            })}
          </nav>
          <div className="space-y-1 border-t border-line p-2">
            <div className="flex items-center gap-1">
              <button className="btn btn-ghost flex-1 justify-start px-3 text-muted" onClick={toggleTheme} title={dark ? 'Light theme' : 'Dark theme'}>
                {dark ? <IconSun size={16} /> : <IconMoon size={16} />}<span className="hidden lg:inline">{dark ? 'Light' : 'Dark'}</span>
              </button>
              <button className="btn btn-ghost hidden px-3 text-muted lg:inline-flex" onClick={logout} title="Sign out"><IconLogout size={16} /></button>
            </div>
            <Link href="/profile" className={`flex items-center gap-2.5 rounded-lg p-2 hover:bg-sunken ${active('/profile') ? 'bg-sunken' : ''}`}>
              <Avatar name={user.name} color={user.avatarColor} />
              <span className="hidden min-w-0 lg:block">
                <span className="block truncate text-sm font-medium">{user.name}</span>
                <span className="block text-[11px] capitalize text-muted">{user.role}</span>
              </span>
            </Link>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center justify-end gap-3 border-b border-line bg-bg/85 px-4 backdrop-blur lg:px-8">
            {shell && (
              <Link href="/status" className="hidden max-w-xl items-center gap-2 truncate rounded-full border border-line bg-panel px-3 py-1 text-xs text-muted hover:text-ink md:flex" title={shell.headline}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[shell.level]}`} />
                <span className="truncate">{shell.level === 'operational' ? 'All systems normal' : shell.headline}</span>
              </Link>
            )}
            <Bell unread={shell?.unread ?? 0} open={bellOpen} setOpen={setBellOpen} onRead={() => void reload(true)} />
          </header>
          <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 lg:px-8">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}

interface Notif { id: number; kind: string; title: string; body: string; link: string | null; read_at: string | null; created_at: string }

function Bell({ unread, open, setOpen, onRead }: { unread: number; open: boolean; setOpen: (v: boolean) => void; onRead: () => void }) {
  const { data, reload } = useApi<{ rows: Notif[] }>(open ? '/api/notifications' : null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, setOpen]);
  const markAll = async () => {
    await apiSend('POST', '/api/notifications', { all: true });
    await reload(true);
    onRead();
  };
  return (
    <div className="relative" ref={ref}>
      <button className="btn btn-ghost relative px-2" onClick={() => setOpen(!open)} aria-label={`Notifications (${unread} unread)`}>
        <IconBell size={18} />
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-bad px-1 text-center text-[10px] font-bold leading-[18px] text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="card absolute right-0 top-11 z-40 w-96 overflow-hidden shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            <button className="text-xs text-accent hover:underline" onClick={markAll}>Mark all as read</button>
          </div>
          <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto">
            {(data?.rows ?? []).map((n) => (
              <li key={n.id}>
                <a href={n.link ?? '#'} className={`block px-4 py-3 hover:bg-sunken ${n.read_at ? 'opacity-60' : ''}`}>
                  <div className="flex items-start gap-2">
                    {!n.read_at && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{n.title}</div>
                      {n.body && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{n.body}</div>}
                      <div className="mt-1 text-[11px] text-muted">{fmtAgo(n.created_at)}</div>
                    </div>
                  </div>
                </a>
              </li>
            ))}
            {data && data.rows.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted">Nothing new.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
