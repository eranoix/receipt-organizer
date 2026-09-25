import { q } from '@/lib/db';
import { api, HttpError, readJson } from '@/lib/server/api';
import { logEvent } from '@/lib/server/events';
import { allSettings, setSetting, SETTING_DEFAULTS, type SettingKey } from '@/lib/server/settings';

export const GET = api({}, async () => {
  const inboxes = await q(`SELECT ib.folder_id, ib.label, ib.is_primary, d.path, (SELECT count(*) FROM drive_items c WHERE c.parent_id = ib.folder_id AND NOT c.is_folder AND c.deleted_at IS NULL) AS files
                             FROM inbox_folders ib JOIN drive_items d ON d.id = ib.folder_id ORDER BY ib.is_primary DESC, ib.label`);
  const rules = await q(`SELECT r.id, r.pattern, r.folder_id, d.path FROM folder_rules r LEFT JOIN drive_items d ON d.id = r.folder_id ORDER BY d.path`);
  return {
    settings: await allSettings(), inboxes, rules,
    extractor: process.env.EXTRACTOR === 'http' ? 'http' : 'mock', drive: process.env.DRIVE_ADAPTER === 'graph' ? 'graph' : 'local',
  };
});

export const PATCH = api({ role: 'admin' }, async ({ req, user, traceId }) => {
  const b = await readJson<Partial<Record<SettingKey, boolean>> & { addRule?: { pattern: string; folderId: string }; deleteRule?: number }>(req);
  for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) {
    if (typeof b[key] === 'boolean') {
      await setSetting(key, b[key]!, user.id);
      await logEvent({ source: 'audit', action: 'settings.changed', actorId: user.id, traceId, message: `${user.name} turned ${key} ${b[key] ? 'on' : 'off'}` });
    }
  }
  if (b.addRule) {
    const pattern = String(b.addRule.pattern ?? '').trim().toLowerCase();
    if (pattern.length < 2 || pattern.length > 80) throw new HttpError(422, 'Keywords must be 2 to 80 characters');
    await q('INSERT INTO folder_rules (pattern, folder_id, created_by) VALUES ($1, $2, $3)', [pattern, b.addRule.folderId, user.id]);
  }
  if (b.deleteRule) await q('DELETE FROM folder_rules WHERE id = $1', [Number(b.deleteRule)]);
  return { ok: true };
});
