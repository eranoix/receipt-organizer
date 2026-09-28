import { parseReceiptText } from './parse';
import { readTextLayer } from './text-layer';
import { RateLimitedError, UnreadableError, type ExtractInput, type ExtractResult, type Extractor } from './types';

export interface MockExtractorOptions {
  rateLimitEvery?: number;
  retryAfterMs?: number;
}

export class MockExtractor implements Extractor {
  readonly name = 'mock';
  private calls = 0;

  constructor(private readonly opts: MockExtractorOptions = {}) {}

  async extract(input: ExtractInput, signal?: AbortSignal): Promise<ExtractResult> {
    signal?.throwIfAborted();
    this.calls += 1;
    if (this.opts.rateLimitEvery && this.calls % this.opts.rateLimitEvery === 0) {
      throw new RateLimitedError(this.opts.retryAfterMs ?? 3_000);
    }
    const text = readTextLayer(input.bytes, input.mime);
    if (!text || !text.trim()) throw new UnreadableError(`no readable text in ${input.name} (photo without a text layer?)`);
    const parsed = parseReceiptText(text);
    return { fields: parsed.fields, confidence: parsed.confidence, rawText: text, provider: this.name };
  }
}
