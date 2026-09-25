import { assertSafeUrl } from './ssrf';
import { RateLimitedError, UnreadableError, type ExtractedFields, type ExtractInput, type ExtractResult, type Extractor } from './types';

/**
 * Adapter for an external OCR/LLM extraction service. Posts the document and
 * expects `{ fields, confidence, text }` back. The endpoint passes the SSRF
 * guard on every call (DNS can change under us), 429 becomes a
 * RateLimitedError carrying Retry-After, and 4xx other than 429 is treated
 * as "this document cannot be read" rather than retried forever.
 */
export class HttpExtractor implements Extractor {
  readonly name = 'http';

  constructor(private readonly cfg: { url: string; apiKey?: string; allowedHosts: string[] }) {}

  async extract(input: ExtractInput, signal?: AbortSignal): Promise<ExtractResult> {
    const url = await assertSafeUrl(this.cfg.url, this.cfg.allowedHosts);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': input.mime ?? 'application/octet-stream',
        'x-file-name': encodeURIComponent(input.name),
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: new Uint8Array(input.bytes),
      signal,
      redirect: 'error',
    });
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      throw new RateLimitedError(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 30_000);
    }
    if (res.status >= 400 && res.status < 500) throw new UnreadableError(`extractor refused the document (${res.status})`);
    if (!res.ok) throw Object.assign(new Error(`extractor returned ${res.status}`), { status: res.status });
    const j = (await res.json()) as { fields?: Partial<ExtractedFields>; confidence?: number; text?: string };
    const f = j.fields ?? {};
    return {
      fields: {
        payee: f.payee ?? null, payeeTaxId: f.payeeTaxId ?? null, amountCents: f.amountCents ?? null,
        paymentDate: f.paymentDate ?? null, method: f.method ?? null, reference: f.reference ?? null,
      },
      confidence: Math.max(0, Math.min(1, j.confidence ?? 0)),
      rawText: j.text ?? null,
      provider: this.name,
    };
  }
}
