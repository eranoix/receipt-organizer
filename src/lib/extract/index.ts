import { HttpExtractor } from './http';
import { MockExtractor } from './mock';
import { allowedHostsFromEnv } from './ssrf';
import type { Extractor } from './types';

const g = globalThis as unknown as { __roExtractor?: Extractor };

export function extractor(): Extractor {
  if (!g.__roExtractor) {
    if (process.env.EXTRACTOR === 'http' && process.env.EXTRACTOR_URL) {
      g.__roExtractor = new HttpExtractor({ url: process.env.EXTRACTOR_URL, apiKey: process.env.EXTRACTOR_API_KEY, allowedHosts: allowedHostsFromEnv() });
    } else {
      g.__roExtractor = new MockExtractor({ rateLimitEvery: Number(process.env.EXTRACTOR_MOCK_RATE_LIMIT_EVERY ?? 0) });
    }
  }
  return g.__roExtractor;
}

export function setExtractor(e: Extractor): void {
  g.__roExtractor = e;
}

export * from './types';
