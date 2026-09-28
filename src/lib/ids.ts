import { randomBytes } from 'node:crypto';

export function newId(prefix: string, bytes = 6): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}

export function newTraceId(): string {
  return newId('tr', 8);
}
