/**
 * Path guards shared by host adapters that write inside the managed Learning
 * root (project scaffolding, staging references, project generation).
 */

export function assertCurrentProjectPath(path: string, root: string): void {
  assertPathInRoot(path, root)
  if (normalizePath(path) === normalizePath(root)) {
    throw new Error(`Expected a project below Learning root: ${path}`)
  }
}

export function assertPathInRoot(
  path: string,
  root: string,
  child?: string,
): void {
  const normalizedPath = normalizePath(path)
  const normalizedRoot = normalizePath(root)
  const requiredRoot = child ? `${normalizedRoot}/${child}` : normalizedRoot
  if (
    normalizedPath !== requiredRoot &&
    !normalizedPath.startsWith(`${requiredRoot}/`)
  ) {
    throw new Error(`Path is outside the current Learning root: ${path}`)
  }
}

export function normalizePath(path: string): string {
  const segments: string[] = []
  for (const segment of path.trim().replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) throw new Error(`Invalid vault path: ${path}`)
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  if (segments.length === 0) throw new Error(`Invalid vault path: ${path}`)
  return segments.join('/')
}
