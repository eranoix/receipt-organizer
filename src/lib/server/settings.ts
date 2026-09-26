import { q, q1 } from '../db';

/**
 * Defaults live in code, so a missing row can never flip a safety feature
 * off.
 */
export const SETTING_DEFAULTS = {
  'dedup.enabled': true,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export async function getSetting<K extends SettingKey>(key: K): Promise<(typeof SETTING_DEFAULTS)[K]> {
  const row = await q1<{ value: (typeof SETTING_DEFAULTS)[K] }>('SELECT value FROM settings WHERE key = $1', [key]);
  return row ? row.value : SETTING_DEFAULTS[key];
}

export async function allSettings(): Promise<Record<SettingKey, boolean>> {
  const rows = await q<{ key: SettingKey; value: boolean }>('SELECT key, value FROM settings');
  const out = { ...SETTING_DEFAULTS } as Record<SettingKey, boolean>;
  for (const r of rows) if (r.key in out) out[r.key] = r.value;
  return out;
}

export async function setSetting(key: SettingKey, value: boolean, userId: number | null): Promise<void> {
  await q(`INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), userId]);
}
