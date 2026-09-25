'use client';

import { useEffect, useState } from 'react';
import { apiSend, fmtAgo, fmtDate, useApi } from '../client';
import { IconShield } from '../icons';
import { useToast } from '../toast';
import { Avatar, Badge, Field, PageHeader, Spinner } from '../ui';

interface Me {
  user: { id: number; name: string; email: string; role: string; avatarColor: string; statusText: string; theme: 'system' | 'light' | 'dark'; notify: { dlq: boolean; duplicates: boolean; bills: boolean } };
  meta: { created_at: string; last_login_at: string | null };
  scopes: string[];
  sessions: { created_at: string; expires_at: string; user_agent: string | null }[];
}

const COLORS = ['#0f766e', '#1d4ed8', '#7c3aed', '#b45309', '#be123c', '#15803d', '#475569'];

export function Profile() {
  const { data, reload } = useApi<Me>('/api/me');
  const toast = useToast();
  const [p, setP] = useState({ name: '', statusText: '', avatarColor: COLORS[0], theme: 'system' as Me['user']['theme'], notify: { dlq: true, duplicates: true, bills: true } });
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwErr, setPwErr] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data) setP({ name: data.user.name, statusText: data.user.statusText, avatarColor: data.user.avatarColor, theme: data.user.theme, notify: data.user.notify });
  }, [data]);
  if (!data) return <div className="flex justify-center py-20 text-muted"><Spinner size={20} /></div>;

  const save = async () => {
    try {
      await apiSend('PATCH', '/api/me', p);
      const dark = p.theme === 'dark' || (p.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', dark);
      toast({ tone: 'ok', title: 'Profile saved' });
      await reload(true);
    } catch (e) {
      toast({ tone: 'bad', title: 'Not saved', body: (e as Error).message });
    }
  };
  const changePw = async () => {
    try {
      await apiSend('POST', '/api/me/password', pw);
      setPw({ current: '', next: '' });
      setPwErr({});
      toast({ tone: 'ok', title: 'Password changed' });
    } catch (e) {
      setPwErr(((e as { details?: Record<string, string> }).details) ?? {});
      toast({ tone: 'bad', title: 'Password not changed', body: (e as Error).message });
    }
  };

  return (
    <>
      <PageHeader title="Your profile" />
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="h-24" style={{ background: `linear-gradient(120deg, ${p.avatarColor}, ${p.avatarColor}55)` }} />
        <div className="flex flex-wrap items-end gap-4 bg-panel px-5 pb-4">
          <div className="-mt-8 rounded-full ring-4 ring-panel"><Avatar name={p.name || data.user.name} color={p.avatarColor} size={72} /></div>
          <div className="min-w-0 flex-1 pt-2">
            <div className="text-lg font-semibold">{data.user.name}</div>
            <div className="text-sm text-muted">{data.user.email} · <span className="capitalize">{data.user.role}</span> · member since {fmtDate(data.meta.created_at)}</div>
            {data.user.statusText && <div className="mt-1 text-sm">{data.user.statusText}</div>}
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="card space-y-4 p-4">
          <h2 className="text-sm font-semibold">About you</h2>
          <Field label="Name"><input className="input" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
          <Field label="Status"><input className="input" value={p.statusText} maxLength={120} onChange={(e) => setP({ ...p, statusText: e.target.value })} placeholder="What do you look after?" /></Field>
          <div>
            <span className="label">Color</span>
            <div className="flex gap-2">{COLORS.map((c) => <button key={c} aria-label={`Color ${c}`} onClick={() => setP({ ...p, avatarColor: c })} className={`h-7 w-7 rounded-full ${p.avatarColor === c ? 'ring-2 ring-accent ring-offset-2 ring-offset-panel' : ''}`} style={{ background: c }} />)}</div>
          </div>
          <div>
            <span className="label">Theme</span>
            <div className="flex gap-2">{(['system', 'light', 'dark'] as const).map((t) => <button key={t} className={`chip capitalize ${p.theme === t ? 'chip-on' : ''}`} onClick={() => setP({ ...p, theme: t })}>{t}</button>)}</div>
          </div>
          <div>
            <span className="label">Tell me when</span>
            {([['dlq', 'an operation fails for good and needs a decision'], ['duplicates', 'a possible duplicate arrives'], ['bills', 'a payment settles or a bill is due']] as const).map(([k, l]) => (
              <label key={k} className="mt-1 flex items-center gap-2 text-sm"><input type="checkbox" checked={p.notify[k]} onChange={() => setP({ ...p, notify: { ...p.notify, [k]: !p.notify[k] } })} />{l}</label>
            ))}
          </div>
          <button className="btn btn-primary" onClick={save}>Save</button>
        </section>

        <div className="space-y-4">
          <section className="card space-y-3 p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><IconShield size={15} />Security</h2>
            <Field label="Current password" error={pwErr.current}><input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
            <Field label="New password" error={pwErr.next} hint="At least 10 characters"><input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
            <button className="btn" disabled={!pw.current || !pw.next} onClick={changePw}>Change password</button>
            <div>
              <span className="label">Recent sessions</span>
              <ul className="space-y-1 text-xs text-muted">
                {data.sessions.map((s) => <li key={s.created_at}>{s.user_agent?.split(' ')[0] ?? 'Browser'} · signed in {fmtAgo(s.created_at)} · expires {fmtDate(s.expires_at)}</li>)}
              </ul>
            </div>
          </section>
          <section className="card p-4">
            <h2 className="mb-2 text-sm font-semibold">What you can see</h2>
            <div className="flex flex-wrap gap-1.5">{data.scopes.map((s) => <Badge key={s} tone="accent">{s}</Badge>)}</div>
          </section>
        </div>
      </div>
    </>
  );
}
