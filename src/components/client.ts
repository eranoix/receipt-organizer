'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: Record<string, string>, readonly traceId?: string) {
    super(message);
  }
}

export function newKey(prefix = 'k'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function apiSend<T = unknown>(method: string, url: string, body?: unknown, traceId = newKey('tr')): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-trace-id': traceId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && typeof window !== 'undefined' && !url.includes('/auth/')) {
    window.location.href = '/login';
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; details?: Record<string, string>; traceId?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? `Request failed (${res.status})`, json.details, json.traceId);
  return json as T;
}

export function useApi<T>(url: string | null, refreshMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  const seq = useRef(0);

  const load = useCallback(async (quiet = false) => {
    if (!url) return;
    const mine = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const res = await fetch(url, { headers: { 'x-trace-id': newKey('tr') } });
      if (res.status === 401) { window.location.href = '/login'; return; }
      const json = await res.json();
      if (mine !== seq.current) return;
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
      setData(json as T);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    void load();
    if (!refreshMs) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);

  return { data, error, loading, reload: load, setData };
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'BRL' });
export const fmtMoney = (cents: number | null | undefined) => (cents == null ? '-' : money.format(cents / 100));

export function fmtDate(v: string | null | undefined): string {
  if (!v) return '-';
  const d = new Date(v.length === 10 ? `${v}T12:00:00Z` : v);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '-';
  return new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtAgo(v: string | null | undefined): string {
  if (!v) return 'never';
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 3600) return `in ${Math.round(f / 60)} min`;
    if (f < 86400 * 2) return `in ${Math.round(f / 3600)} h`;
    return `in ${Math.round(f / 86400)} days`;
  }
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const METHOD_LABEL: Record<string, string> = { pix: 'Pix', boleto: 'Boleto', card: 'Card', transfer: 'Transfer', cash: 'Cash' };
