import { api } from '@/lib/server/api';
import { systemStatus } from '@/lib/server/status';

export const GET = api({}, async ({ user }) => systemStatus(user.role === 'admin'));
