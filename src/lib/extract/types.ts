export type PaymentMethod = 'pix' | 'boleto' | 'card' | 'transfer' | 'cash';

export interface ExtractedFields {
  payee: string | null;
  payeeTaxId: string | null;
  amountCents: number | null;
  /** YYYY-MM-DD */
  paymentDate: string | null;
  method: PaymentMethod | null;
  reference: string | null;
}

export const FIELD_KEYS: (keyof ExtractedFields)[] = ['payee', 'payeeTaxId', 'amountCents', 'paymentDate', 'method', 'reference'];

export interface ExtractResult {
  fields: ExtractedFields;
  /** 0..1 for the whole document. */
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

/** The provider said "slow down". Not a failure: the run is rescheduled, never dropped. */
export class RateLimitedError extends Error {
  override readonly name = 'RateLimitedError';
  constructor(readonly retryAfterMs: number) {
    super(`rate limited, retry in ${Math.round(retryAfterMs / 1000)}s`);
  }
}

/** The document cannot be read and trying again will not change that. */
export class UnreadableError extends Error {
  override readonly name = 'UnreadableError';
}
