export type PaymentMethod = 'pix' | 'boleto' | 'card' | 'transfer' | 'cash';

export interface ExtractedFields {
  payee: string | null;
  payeeTaxId: string | null;
  amountCents: number | null;
  paymentDate: string | null;
  method: PaymentMethod | null;
  reference: string | null;
}

export const FIELD_KEYS: (keyof ExtractedFields)[] = ['payee', 'payeeTaxId', 'amountCents', 'paymentDate', 'method', 'reference'];

export interface ExtractResult {
  fields: ExtractedFields;
  confidence: number;
  rawText: string | null;
  provider: string;
}

export interface ExtractInput {
  bytes: Buffer;
  name: string;
  mime: string | null;
}

export interface Extractor {
  readonly name: string;
  extract(input: ExtractInput, signal?: AbortSignal): Promise<ExtractResult>;
}

export class RateLimitedError extends Error {
  override readonly name = 'RateLimitedError';
  constructor(readonly retryAfterMs: number) {
    super(`rate limited, retry in ${Math.round(retryAfterMs / 1000)}s`);
  }
}

export class UnreadableError extends Error {
  override readonly name = 'UnreadableError';
}
