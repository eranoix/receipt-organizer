import { api } from '@/lib/server/api';
import { folderTree } from '@/lib/server/files';

export const GET = api({}, async ({ user }) => ({ folders: await folderTree(user) }));
