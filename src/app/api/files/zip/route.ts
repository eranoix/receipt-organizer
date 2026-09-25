import { api, readJson } from '@/lib/server/api';
import { zipItems } from '@/lib/server/files';

export const POST = api({ role: 'viewer', limit: ['zip', 10, 60_000] }, async ({ req, user }) => {
  const b = await readJson<{ ids?: string[] }>(req);
  const zip = await zipItems(Array.isArray(b.ids) ? b.ids : [], user);
  return new Response(new Uint8Array(zip.bytes), {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(zip.bytes.length),
      'content-disposition': `attachment; filename="${zip.name}"`,
      'x-file-count': String(zip.count),
    },
  });
});
