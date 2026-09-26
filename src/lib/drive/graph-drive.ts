/**
 * Microsoft Graph (OneDrive) adapter.
 *
 * A stub in the honest sense: it is written against the documented REST
 * shapes and wired through the same interface, but this repository ships
 * with no tenant, so it is exercised only when the GRAPH_* variables are
 * set. The parts that matter for correctness are here: the provider's error
 * code is carried into DriveError (the queue classifies on it), Retry-After
 * is honoured, conflicts fail instead of renaming, and every call takes the
 * AbortSignal.
 */

import { DriveError, type DeltaPage, type DriveAdapter, type DriveChange, type DriveErrorCode, type DriveItem } from './types';

const GRAPH = 'https://graph.microsoft.com/v1.0';

interface GraphItem {
  id: string; name: string; size?: number; eTag?: string; lastModifiedDateTime?: string;
  parentReference?: { id?: string }; folder?: object; file?: { mimeType?: string }; deleted?: object; root?: object;
}

export interface GraphConfig { tenantId: string; clientId: string; clientSecret: string; driveId: string; notificationUrl?: string }

export function graphConfigFromEnv(env = process.env): GraphConfig | null {
  const { GRAPH_TENANT_ID: tenantId, GRAPH_CLIENT_ID: clientId, GRAPH_CLIENT_SECRET: clientSecret, GRAPH_DRIVE_ID: driveId } = env;
  if (!tenantId || !clientId || !clientSecret || !driveId) return null;
  return { tenantId, clientId, clientSecret, driveId, notificationUrl: env.GRAPH_NOTIFICATION_URL };
}

export class GraphDrive implements DriveAdapter {
  readonly kind = 'graph' as const;
  private token: { value: string; expiresAt: number } | null = null;
  private root: string | null = null;

  constructor(private readonly cfg: GraphConfig) {}

  async rootId() {
    if (!this.root) this.root = (await this.call<GraphItem>('GET', `/drives/${this.cfg.driveId}/root`)).id;
    return this.root;
  }

  async delta(cursor: string | null, signal?: AbortSignal): Promise<DeltaPage> {
    let url = cursor ?? `${GRAPH}/drives/${this.cfg.driveId}/root/delta`;
    const changes: DriveChange[] = [];
    for (let page = 0; page < 500; page += 1) {
      const res = await this.call<{ value: GraphItem[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }>('GET', url, undefined, signal);
      for (const it of res.value) changes.push(it.deleted ? { type: 'delete', id: it.id } : { type: 'upsert', item: toItem(it) });
      if (res['@odata.deltaLink']) return { changes, cursor: res['@odata.deltaLink'], reset: cursor === null };
      if (!res['@odata.nextLink']) break;
      url = res['@odata.nextLink'];
    }
    throw new DriveError('unknown', 'delta did not return a deltaLink');
  }

  async listAll(signal?: AbortSignal) {
    const page = await this.delta(null, signal);
    return page.changes.flatMap((c) => (c.type === 'upsert' ? [c.item] : []));
  }

  async get(id: string, signal?: AbortSignal) {
    try {
      return toItem(await this.call<GraphItem>('GET', `/drives/${this.cfg.driveId}/items/${id}`, undefined, signal));
    } catch (err) {
      if (err instanceof DriveError && err.code === 'itemNotFound') return null;
      throw err;
    }
  }

  async childByName(parentId: string, name: string, signal?: AbortSignal) {
    try {
      const it = await this.call<GraphItem>('GET', `/drives/${this.cfg.driveId}/items/${parentId}:/${encodeURIComponent(name)}`, undefined, signal);
      return toItem(it);
    } catch (err) {
      if (err instanceof DriveError && err.code === 'itemNotFound') return null;
      throw err;
    }
  }

  async read(id: string, signal?: AbortSignal) {
    const res = await this.raw('GET', `/drives/${this.cfg.driveId}/items/${id}/content`, undefined, signal);
    return Buffer.from(await res.arrayBuffer());
  }

  async createFolder(parentId: string, name: string, signal?: AbortSignal) {
    return toItem(await this.call<GraphItem>('POST', `/drives/${this.cfg.driveId}/items/${parentId}/children`,
      { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }, signal));
  }

  async move(id: string, parentId: string, name: string, signal?: AbortSignal) {
    return toItem(await this.call<GraphItem>('PATCH', `/drives/${this.cfg.driveId}/items/${id}?@microsoft.graph.conflictBehavior=fail`,
      { name, parentReference: { id: parentId } }, signal));
  }

  async delete(id: string, signal?: AbortSignal) {
    await this.raw('DELETE', `/drives/${this.cfg.driveId}/items/${id}`, undefined, signal);
  }

  async upload(parentId: string, name: string, bytes: Buffer, signal?: AbortSignal) {
    const res = await this.raw('PUT', `/drives/${this.cfg.driveId}/items/${parentId}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`,
      bytes, signal, 'application/octet-stream');
    return toItem((await res.json()) as GraphItem);
  }

  async subscribe(signal?: AbortSignal) {
    if (!this.cfg.notificationUrl) throw new DriveError('notConfigured', 'GRAPH_NOTIFICATION_URL is not set');
    const expiresAt = new Date(Date.now() + 2.5 * 24 * 3600_000).toISOString();
    await this.call('POST', '/subscriptions', {
      changeType: 'updated', notificationUrl: this.cfg.notificationUrl, resource: `/drives/${this.cfg.driveId}/root`, expirationDateTime: expiresAt,
    }, signal);
    return { expiresAt };
  }

  private async call<T>(method: string, pathOrUrl: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.raw(method, pathOrUrl, body === undefined ? undefined : JSON.stringify(body), signal, 'application/json');
    return (await res.json()) as T;
  }

  private async raw(method: string, pathOrUrl: string, body: BodyInit | Buffer | undefined, signal?: AbortSignal, contentType?: string): Promise<Response> {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
    if (!url.startsWith(`${GRAPH}/`)) throw new DriveError('invalidRequest', 'refusing to call a non-Graph URL');
    const headers: Record<string, string> = { authorization: `Bearer ${await this.accessToken(signal)}` };
    if (contentType && body !== undefined) headers['content-type'] = contentType;
    const res = await fetch(url, { method, headers, body: body as BodyInit | undefined, signal });
    if (res.ok) return res;
    let code: string | undefined;
    let message = `${method} ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      code = j.error?.code;
      message = j.error?.message ?? message;
    } catch { /* body was not JSON */ }
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new DriveError(mapCode(res.status, code), message, res.status, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
  }

  private async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }),
      signal,
    });
    if (!res.ok) throw new DriveError('accessDenied', `token request failed with ${res.status}`, res.status);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }
}

function mapCode(status: number, code?: string): DriveErrorCode {
  const known: DriveErrorCode[] = ['nameAlreadyExists', 'itemNotFound', 'accessDenied', 'invalidRequest', 'quotaLimitReached'];
  if (code && (known as string[]).includes(code)) return code as DriveErrorCode;
  if (status === 404) return 'itemNotFound';
  if (status === 409) return 'nameAlreadyExists';
  if (status === 401 || status === 403) return 'accessDenied';
  if (status === 429) return 'throttled';
  if (status >= 500) return 'serviceUnavailable';
  if (status >= 400) return 'invalidRequest';
  return 'unknown';
}

function toItem(it: GraphItem): DriveItem {
  return {
    id: it.id, parentId: it.root ? null : it.parentReference?.id ?? null, name: it.name ?? '', isFolder: !!it.folder || !!it.root,
    size: it.size ?? 0, mime: it.file?.mimeType ?? null, etag: it.eTag ?? '', modifiedAt: it.lastModifiedDateTime ?? new Date(0).toISOString(),
  };
}
