export interface DriveItem {
  id: string;
  parentId: string | null;
  name: string;
  isFolder: boolean;
  size: number;
  mime: string | null;
  etag: string;
  modifiedAt: string;
}

export type DriveChange = { type: 'upsert'; item: DriveItem } | { type: 'delete'; id: string };

export interface DeltaPage {
  changes: DriveChange[];
  cursor: string;
  reset: boolean;
}

export type DriveErrorCode =
  | 'nameAlreadyExists' | 'itemNotFound' | 'accessDenied' | 'invalidRequest' | 'quotaLimitReached'
  | 'throttled' | 'serviceUnavailable' | 'timeout' | 'notConfigured' | 'unknown';

export class DriveError extends Error {
  override readonly name = 'DriveError';
  constructor(readonly code: DriveErrorCode, message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

export interface DriveAdapter {
  readonly kind: 'local' | 'graph';
  rootId(): Promise<string>;
  delta(cursor: string | null, signal?: AbortSignal): Promise<DeltaPage>;
  listAll(signal?: AbortSignal): Promise<DriveItem[]>;
  get(id: string, signal?: AbortSignal): Promise<DriveItem | null>;
  childByName(parentId: string, name: string, signal?: AbortSignal): Promise<DriveItem | null>;
  read(id: string, signal?: AbortSignal): Promise<Buffer>;
  createFolder(parentId: string, name: string, signal?: AbortSignal): Promise<DriveItem>;
  move(id: string, parentId: string, name: string, signal?: AbortSignal): Promise<DriveItem>;
  delete(id: string, signal?: AbortSignal): Promise<void>;
  upload(parentId: string, name: string, bytes: Buffer, signal?: AbortSignal): Promise<DriveItem>;
  subscribe(signal?: AbortSignal): Promise<{ expiresAt: string }>;
}

export function mimeFor(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop();
  return ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain' } as Record<string, string>)[ext ?? ''] ?? null;
}
