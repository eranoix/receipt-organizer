'use client';

import { useEffect } from 'react';
import { IconX } from './icons';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'accent' | 'muted';
const toneCls: Record<Tone, string> = {
  ok: 'border-ok/30 bg-ok/10 text-ok',
  warn: 'border-warn/30 bg-warn/10 text-warn',
  bad: 'border-bad/30 bg-bad/10 text-bad',
  accent: 'border-accent/30 bg-accent/10 text-accent',
  muted: 'border-line bg-sunken text-muted',
};

export function Badge({ tone = 'muted', children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return <span className={`badge ${toneCls[tone]}`} title={title}>{children}</span>;
}

const STAGES: Record<string, [string, Tone]> = {
  suggested: ['Suggested', 'accent'],
  needs_decision: ['Needs a decision', 'warn'],
  reading: ['Reading', 'muted'],
  unreadable: ['Unreadable', 'bad'],
  duplicate: ['Duplicate?', 'warn'],
  filed: ['Filed', 'ok'],
};

export function StageBadge({ stage }: { stage: string | null | undefined }) {
  if (!stage) return null;
  const [label, tone] = STAGES[stage] ?? [stage, 'muted'];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Confidence({ value, compact }: { value: number | null | undefined; compact?: boolean }) {
  if (value == null) return <span className="text-xs text-muted">-</span>;
  const pct = Math.round(value * 100);
  const tone = value >= 0.8 ? 'bg-ok' : value >= 0.5 ? 'bg-warn' : 'bg-bad';
  return (
    <div className="flex items-center gap-2" title={`${pct}% confidence (suggested at 80% or more)`}>
      <div className={`relative h-1.5 ${compact ? 'w-12' : 'w-20'} overflow-hidden rounded-full bg-sunken`}>
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
        <div className="absolute inset-y-0 w-px bg-ink/40" style={{ left: '80%' }} />
      </div>
      <span className="w-8 text-xs tabular-nums text-muted">{pct}%</span>
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-muted">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="mt-1 max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="inline-block animate-spin rounded-full border-2 border-current border-r-transparent" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function Progress({ value, max, tone = 'accent' }: { value: number; max: number; tone?: 'accent' | 'ok' | 'bad' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full transition-all ${tone === 'ok' ? 'bg-ok' : tone === 'bad' ? 'bg-bad' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${value === t.id ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink'}`}>
          {t.label}
          {t.count !== undefined && <span className={`rounded-full px-1.5 text-[11px] ${value === t.id ? 'bg-accent text-accent-ink' : 'bg-sunken text-muted'}`}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]" onMouseDown={onClose}>
      <div role="dialog" aria-modal aria-label={title} className={`card w-full ${wide ? 'max-w-2xl' : 'max-w-md'} shadow-2xl`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button className="text-muted hover:text-ink" onClick={onClose} aria-label="Close"><IconX /></button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Avatar({ name, color, size = 28 }: { name: string; color: string; size?: number }) {
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white" style={{ background: color, width: size, height: size, fontSize: size * 0.38 }}>
      {initials}
    </span>
  );
}

export function Stat({ label, value, hint, tone, href }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: Tone; href?: string }) {
  const inner = (
    <div className={`card h-full p-4 ${href ? 'transition hover:border-accent/50' : ''}`}>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`mt-1.5 text-2xl font-semibold tabular-nums ${tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : ''}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
  return href ? <a href={href} className="block">{inner}</a> : inner;
}

export function Field({ label, error, children, hint }: { label: string; error?: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-bad">{error}</span> : hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}
