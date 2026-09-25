'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import { IconAlert, IconCheck, IconX } from './icons';

type Tone = 'ok' | 'bad' | 'info';
interface Toast { id: number; title: string; body?: string; tone: Tone }

const Ctx = createContext<(t: Omit<Toast, 'id'>) => void>(() => undefined);

export function useToast() {
  return useContext(Ctx);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.tone === 'bad' ? 7000 : 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="card pointer-events-auto flex gap-2.5 p-3 shadow-lg">
            <span className={t.tone === 'bad' ? 'text-bad' : t.tone === 'ok' ? 'text-ok' : 'text-accent'}>
              {t.tone === 'bad' ? <IconAlert /> : <IconCheck />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{t.title}</div>
              {t.body && <div className="mt-0.5 text-xs text-muted">{t.body}</div>}
            </div>
            <button className="text-muted hover:text-ink" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} aria-label="Dismiss"><IconX size={14} /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
