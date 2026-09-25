import { randomBytes } from 'node:crypto';

/** Short random id with a readable prefix, e.g. `tr_3f9c1a0b2d4e`. */
export function newId(prefix: string, bytes = 6): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}

/** A trace id ties together everything one user action or one intake caused. */
export function newTraceId(): string {
  return newId('tr', 8);
}
