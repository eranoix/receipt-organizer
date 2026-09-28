export function pathInScope(path: string, scopePaths: string[]): boolean {
  return scopePaths.some((s) => s === '/' || path === s || path.startsWith(s.endsWith('/') ? s : `${s}/`));
}
