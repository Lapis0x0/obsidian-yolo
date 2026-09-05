import { type App, FileSystemAdapter } from 'obsidian'

// Path resolution and vault-boundary judgment for the desktop-only
// `native_files` capability (docs/plans/09-05-yolo-max/master.md Q3/Q7,
// p1-design.md §3).
//
// Distinct from `workspaceScope.ts` on purpose: that module reasons about
// *vault-relative* paths (`isPathAllowedByScope` is a vault-relative prefix
// match) and structurally cannot answer "is this absolute path inside the
// vault at all" — the question every native tool has, because its paths are
// real filesystem paths that may point anywhere on the machine
// (facts-for-design.md §4).

/**
 * The vault's real directory on disk. Throws on any adapter that isn't the
 * desktop filesystem one — a native file tool has nothing to resolve
 * relative paths against there, and silently falling back to `process.cwd()`
 * would put writes somewhere the user never named.
 */
export function getVaultBasePath(app: App): string {
  const adapter = app.vault.adapter
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error(
      'This vault is not backed by the local filesystem, so native file tools cannot resolve paths. They are desktop-only.',
    )
  }
  return adapter.getBasePath()
}

/**
 * Resolves a model-supplied path to an absolute, normalized filesystem path.
 *
 *   - absolute path        -> used as given (still normalized)
 *   - `~` / `~/...`        -> expanded against the OS home directory
 *   - anything else        -> resolved against the vault root
 *
 * `node:path` / `node:os` are imported dynamically so this module stays out
 * of the mobile static graph (AGENTS.md "Runtime Boundaries"); the callers
 * are desktop-only tools, but the import graph is what the build checks.
 */
export async function resolveNativePath(
  app: App,
  inputPath: string,
): Promise<string> {
  const [path, os] = await Promise.all([
    // eslint-disable-next-line import/no-nodejs-modules -- desktop-only, dynamically imported so mobile never loads it
    import('node:path'),
    // eslint-disable-next-line import/no-nodejs-modules -- desktop-only, dynamically imported so mobile never loads it
    import('node:os'),
  ])

  const raw = inputPath.trim()
  if (raw === '') {
    throw new Error('path must be a non-empty string.')
  }

  let candidate = raw
  if (candidate === '~') {
    candidate = os.homedir()
  } else if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    candidate = path.join(os.homedir(), candidate.slice(2))
  }

  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(getVaultBasePath(app), candidate)
}

/**
 * True when `absPath` is the vault root itself or lives underneath it.
 *
 * Both arguments must already be absolute and `..`-resolved (that is what
 * `resolveNativePath` returns) — this is a boundary comparison, not a
 * normalizer, and it deliberately does not touch the filesystem so the tool
 * gateway can call it synchronously while deciding whether a call needs
 * approval.
 *
 * Case sensitivity follows the *shape* of the paths rather than
 * `Platform.isWin`: a Windows path is recognizable on sight (`C:\...` or a
 * `\\server\share` UNC prefix) and always is one when the vault lives on
 * Windows, so the judgment stays a pure function of its arguments instead of
 * depending on ambient platform state that tests would have to fake.
 */
export function isInsideVault(absPath: string, vaultBasePath: string): boolean {
  const windows =
    looksLikeWindowsPath(vaultBasePath) || looksLikeWindowsPath(absPath)
  const base = normalizeForComparison(vaultBasePath, windows)
  const target = normalizeForComparison(absPath, windows)
  if (base === '' || target === '') {
    return false
  }
  if (target === base) {
    return true
  }
  return target.startsWith(base === '/' ? '/' : `${base}/`)
}

const looksLikeWindowsPath = (value: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')

/**
 * Separators unified to '/', runs of separators collapsed, trailing
 * separators dropped (except on a bare root), and — on Windows — case
 * folded. Only what a prefix comparison needs; no `..` handling, see
 * `isInsideVault`'s contract.
 */
const normalizeForComparison = (value: string, windows: boolean): string => {
  let out = value.trim().replace(/\\/g, '/')
  out = out.replace(/\/{2,}/g, '/')
  while (out.length > 1 && out.endsWith('/')) {
    out = out.slice(0, -1)
  }
  return windows ? out.toLowerCase() : out
}
