'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiSend } from '@/components/client';
import { IconReceipt } from '@/components/icons';

const DEMO = [
  { email: 'lia@example.com', who: 'Lia, owner (admin)' },
  { email: 'tom@example.com', who: 'Tom, head baker (member)' },
  { email: 'ines@example.com', who: 'Ines, bookkeeper (read-only)' },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('lia@example.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiSend('POST', '/api/auth/login', { email, password });
      router.push('/');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-ink"><IconReceipt size={22} /></span>
          <div>
            <div className="text-lg font-semibold">Tidyslip</div>
            <div className="text-sm text-muted">Receipts in, filed, matched and paid.</div>
          </div>
        </div>
        <form onSubmit={submit} className="card space-y-4 p-6">
          <label className="block">
            <span className="label">Email</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          </label>
          <label className="block">
            <span className="label">Password</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
          </label>
          {error && <div className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
          <button className="btn btn-primary w-full py-2" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
        </form>
        <div className="mt-4 rounded-xl border border-dashed border-line p-4 text-xs text-muted">
          <div className="mb-2 font-medium text-ink">Demo accounts (password <code className="kbd">receipts-demo</code>)</div>
          <ul className="space-y-1">
            {DEMO.map((d) => (
              <li key={d.email}>
                <button type="button" className="hover:text-accent" onClick={() => setEmail(d.email)}>{d.email}</button> <span>{d.who}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2">Every person, company and document in this demo is invented.</p>
        </div>
      </div>
    </div>
  );
}
