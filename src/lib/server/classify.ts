import { q, q1 } from '../db';
import { suggestFolder, type HistoryRow } from '../classify/classifier';
import { normalizeKey } from '../text';

export async function loadHistory(): Promise<HistoryRow[]> {
  const rows = await q<{ payee: string; payee_tax_id: string | null; folder_id: string; n: number }>(
    `SELECT r.payee, r.payee_tax_id, d.parent_id AS folder_id, count(*) AS n
       FROM receipts r
       JOIN drive_items d ON d.id = r.file_id AND d.deleted_at IS NULL
       LEFT JOIN inbox_folders ib ON ib.folder_id = d.parent_id
      WHERE ib.folder_id IS NULL AND r.payee IS NOT NULL
      GROUP BY 1, 2, 3`);
  return rows.map((r) => ({ payeeKey: normalizeKey(r.payee), taxId: r.payee_tax_id, folderId: r.folder_id, count: r.n }));
}

export async function validTargetFolders(): Promise<Set<string>> {
  const rows = await q<{ id: string }>(
    `SELECT d.id FROM drive_items d LEFT JOIN inbox_folders ib ON ib.folder_id = d.id
      WHERE d.is_folder AND d.deleted_at IS NULL AND d.parent_id IS NOT NULL AND ib.folder_id IS NULL`);
  return new Set(rows.map((r) => r.id));
}

/** Recompute the folder suggestion for one receipt. Never moves anything. */
export async function refreshSuggestion(fileId: string, ctx?: { history: HistoryRow[]; rules: { pattern: string; folderId: string }[]; folders: Set<string> }): Promise<void> {
  const r = await q1<{ payee: string | null; payee_tax_id: string | null; reference: string | null; raw_text: string | null }>(
    `SELECT r.payee, r.payee_tax_id, r.reference,
            (SELECT raw_text FROM extraction_runs x WHERE x.file_id = r.file_id AND x.raw_text IS NOT NULL ORDER BY id DESC LIMIT 1) AS raw_text
       FROM receipts r WHERE r.file_id = $1`, [fileId]);
  if (!r) return;
  const history = ctx?.history ?? (await loadHistory());
  const rules = ctx?.rules ?? (await q<{ pattern: string; folderId: string }>('SELECT pattern, folder_id AS "folderId" FROM folder_rules'));
  const folders = ctx?.folders ?? (await validTargetFolders());
  const s = suggestFolder({ payee: r.payee, payeeTaxId: r.payee_tax_id, reference: r.reference, rawText: r.raw_text }, history, rules, folders);
  await q(
    `UPDATE receipts SET suggestion_folder_id = $2, suggestion_confidence = $3, suggestion_reasons = $4, suggestion_alternatives = $5, updated_at = now()
      WHERE file_id = $1`,
    [fileId, s.folderId, s.confidence, JSON.stringify(s.reasons), JSON.stringify(s.alternatives)]);
}

/** After a filing changes the history, refresh every receipt still waiting in an inbox. */
export async function refreshInboxSuggestions(): Promise<number> {
  const rows = await q<{ file_id: string }>(`SELECT file_id FROM receipt_view WHERE in_inbox AND stage IN ('suggested', 'needs_decision')`);
  if (rows.length === 0) return 0;
  const ctx = {
    history: await loadHistory(),
    rules: await q<{ pattern: string; folderId: string }>('SELECT pattern, folder_id AS "folderId" FROM folder_rules'),
    folders: await validTargetFolders(),
  };
  for (const r of rows) await refreshSuggestion(r.file_id, ctx);
  return rows.length;
}
