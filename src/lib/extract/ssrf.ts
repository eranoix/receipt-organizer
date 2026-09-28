import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class BlockedUrlError extends Error {
  override readonly name = 'BlockedUrlError';
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowed.some((a) => {
    const rule = a.trim().toLowerCase();
    if (!rule) return false;
    return rule.startsWith('.') ? h.endsWith(rule) || h === rule.slice(1) : h === rule;
  });
}

export async function assertSafeUrl(
  raw: string,
  allowed: string[],
  resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((r) => r.address),
): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new BlockedUrlError('not a valid URL'); }
  if (url.protocol !== 'https:') throw new BlockedUrlError(`only https is allowed (got ${url.protocol})`);
  if (url.username || url.password) throw new BlockedUrlError('credentials in URLs are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) throw new BlockedUrlError('IP literals are not allowed; use a hostname on the allowlist');
  if (!hostAllowed(host, allowed)) throw new BlockedUrlError(`host ${host} is not on the allowlist`);
  const addrs = await resolve(host);
  if (addrs.length === 0) throw new BlockedUrlError(`host ${host} did not resolve`);
  const bad = addrs.find(isPrivateAddress);
  if (bad) throw new BlockedUrlError(`host ${host} resolves to a private address (${bad})`);
  return url;
}

export function allowedHostsFromEnv(env = process.env): string[] {
  return (env.EXTRACTOR_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
