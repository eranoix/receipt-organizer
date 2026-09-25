import { drive } from '@/lib/drive';
import { api, HttpError } from '@/lib/server/api';
import { itemForUser } from '@/lib/server/files';

const SAFE_INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

/**
 * File bytes, behind the same scope check as every listing. Out-of-scope ids
 * answer 404, not 403, so ids cannot be probed.
 */
export const GET = api<{ id: string }>({ limit: ['content', 300, 60_000] }, async ({ req, user, params }) => {
  const it = await itemForUser(params.id, user);
  if (it.is_folder) throw new HttpError(400, 'That is a folder');
  const bytes = await drive().read(it.id, AbortSignal.timeout(30_000));
  const download = req.nextUrl.searchParams.get('download') === '1';
  const type = it.mime && SAFE_INLINE.has(it.mime) ? it.mime : 'application/octet-stream';
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': type,
      'content-length': String(bytes.length),
      'content-disposition': `${download || type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(it.name)}`,
      'cache-control': 'private, max-age=60',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
    },
  });
});
