/**
 * Scoped file access. Members and viewers see only the folders they were
 * given (and everything below them); admins see everything. Checked on every
 * read that returns file bytes, not only on listings: an id guessed or copied
 * from someone else must not be enough to open a document.
 */
export function pathInScope(path: string, scopePaths: string[]): boolean {
  return scopePaths.some((s) => s === '/' || path === s || path.startsWith(s.endsWith('/') ? s : `${s}/`));
}
