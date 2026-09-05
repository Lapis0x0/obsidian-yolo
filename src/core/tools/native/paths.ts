import { type App, FileSystemAdapter } from 'obsidian'

import { getTextArg } from '../tool-args'

// The path contract shared by every tool in this directory: how a
// model-supplied path is described, how it is resolved, and where the vault
// boundary is (docs/plans/09-05-yolo-max/master.md Q3/Q7, §6; p1-design.md §3).
// One contract, not one copy per tool.
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
 * The one session-level permission that covers reaching outside the vault,
 * whichever tool does the reaching (master.md §4 Q7: the thing the user is
 * asked about is the boundary, not the tool). Granted through
 * `McpManager.grantExecutionAllowance` and checked with
 * `isExecutionAllowanceGranted`, so it lives in the same per-conversation
 * allowance set as every "always allow" decision.
 */
export const OUTSIDE_VAULT_ALLOWANCE_KEY = 'native:outside-vault'

/**
 * The extra permissions an "always allow for this chat" on `request` grants
 * beyond that call's own tool and arguments. One helper rather than the same
 * conditional at each of the three approval entry points.
 */
export const getExtraAllowanceKeysForRequest = (request: {
  metadata?: { outsideVaultPath?: string }
}): string[] =>
  request.metadata?.outsideVaultPath === undefined
    ? []
    : [OUTSIDE_VAULT_ALLOWANCE_KEY]

/**
 * The two machine facts every native path resolves against: where relative
 * paths start, and what `~` means. Bundled into one value because the tool
 * gateway needs the exact same pair the tools use — a boundary decision made
 * against a different vault root or home directory than the write itself
 * uses is not a boundary at all.
 */
export type NativePathBoundary = Readonly<{
  /** Absolute vault root; relative paths resolve here, and it is the boundary. */
  vaultBasePath: string
  /** Absolute home directory for `~` expansion; `''` when unknown. */
  homeDir: string
}>

/**
 * This machine's boundary. Throws for the same reason `getVaultBasePath`
 * does. `process.env` rather than `node:os` so the whole path contract stays
 * synchronous — `AgentToolGateway` decides a tool call's initial state
 * synchronously, and an async resolver there would mean two implementations
 * that can disagree about where a write lands.
 */
export function resolveNativePathBoundary(app: App): NativePathBoundary {
  return {
    vaultBasePath: getVaultBasePath(app),
    homeDir:
      (typeof process === 'undefined'
        ? undefined
        : (process.env.HOME ?? process.env.USERPROFILE)) ?? '',
  }
}

/**
 * Resolves a model-supplied path to an absolute, normalized filesystem path.
 *
 *   - absolute path        -> used as given (still normalized)
 *   - `~` / `~/...`        -> expanded against `boundary.homeDir`
 *   - anything else        -> resolved against `boundary.vaultBasePath`
 *
 * Pure string work, no `node:path`: this runs both inside the tools and,
 * synchronously, inside the gateway's approval decision, and those two must
 * be the same function. Separators in the result follow the shape of the
 * inputs — backslashes for a Windows-shaped path, forward slashes otherwise.
 */
export function resolveNativePathWithin(
  boundary: NativePathBoundary,
  inputPath: string,
): string {
  const raw = inputPath.trim()
  if (raw === '') {
    throw new Error('path must be a non-empty string.')
  }

  let candidate = raw
  if (
    candidate === '~' ||
    candidate.startsWith('~/') ||
    candidate.startsWith('~\\')
  ) {
    if (boundary.homeDir === '') {
      throw new Error(
        'Cannot expand "~": this machine reports no home directory. Use an absolute path.',
      )
    }
    candidate =
      candidate === '~'
        ? boundary.homeDir
        : joinUnderRoot(boundary.homeDir, candidate.slice(2))
  }

  return normalizeAbsolutePath(
    isAbsoluteNativePath(candidate)
      ? candidate
      : joinUnderRoot(boundary.vaultBasePath, candidate),
  )
}

/**
 * Joins with a single separator. Dropping the base's trailing separator
 * matters at a filesystem root: `'/' + '/' + rest` would read as the `//`
 * UNC prefix, and a `..` under it would then stop one level too high.
 */
const joinUnderRoot = (base: string, rest: string): string =>
  `${base.replace(/[\\/]+$/, '')}/${rest}`

/**
 * Resolves a model-supplied path against the vault this app is open on. Thin
 * wrapper over {@link resolveNativePathWithin}; kept async because every
 * caller is inside a tool's async `execute`.
 */
export async function resolveNativePath(
  app: App,
  inputPath: string,
): Promise<string> {
  return resolveNativePathWithin(resolveNativePathBoundary(app), inputPath)
}

const WINDOWS_DRIVE_ROOT = /^[a-zA-Z]:[\\/]/

/**
 * True for a rooted filesystem path (`/x`, `\\server\share`, `C:\x`).
 *
 * Exported because the chat surface has to tell the two shapes of
 * `editSummary` path apart — see {@link toEditSummaryPath} — and that
 * judgment must be the same one the tools resolve with, not a second
 * `startsWith('/')` written somewhere else.
 */
export const isAbsoluteNativePath = (value: string): boolean =>
  value.startsWith('/') ||
  value.startsWith('\\') ||
  WINDOWS_DRIVE_ROOT.test(value)

/**
 * Collapses `.`/`..`/duplicate separators in an already-rooted path, keeping
 * the root prefix (`/`, `//server`, `C:/`) intact. `..` at the root is
 * dropped rather than escaping it, matching `path.resolve`.
 */
const normalizeAbsolutePath = (value: string): string => {
  const windows = looksLikeWindowsPath(value)
  const unified = value.replace(/\\/g, '/')

  let root = '/'
  let rest = unified.slice(1)
  const driveMatch = /^([a-zA-Z]:)\//.exec(unified)
  if (unified.startsWith('//')) {
    root = '//'
    rest = unified.slice(2)
  } else if (driveMatch) {
    root = `${driveMatch[1]}/`
    rest = unified.slice(driveMatch[0].length)
  }

  const segments: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  let out = `${root}${segments.join('/')}`
  if (out.length > 1 && out.endsWith('/')) {
    out = out.slice(0, -1)
  }
  return windows ? out.replace(/\//g, '\\') : out
}

/**
 * The `path` property description every native file tool exposes. Written
 * for the model: it has to be able to tell these apart from the vault-backed
 * `fs_*` tools, which take vault-relative paths and resolve wikilinks.
 */
export const NATIVE_PATH_ARG_DESCRIPTION =
  'Filesystem path. Absolute ("/Users/me/x.md", "C:\\\\work\\\\x.md"), home-relative ("~/x.md"), ' +
  'or relative to the vault root. Any extension, hidden directories, and locations outside the ' +
  'vault are all allowed. This is a real path on disk — never a wikilink, a skill path, or a ' +
  'browser:// page id.'

/** Reads the `path` argument and resolves it to an absolute path. */
export const resolveNativeFilePathArg = async (
  app: App,
  args: Record<string, unknown>,
): Promise<string> => resolveNativePath(app, getTextArg(args, 'path'))

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

/**
 * The path shape an edit review snapshot / `editSummary` records for a native
 * write: **vault-relative** for a file inside the vault, absolute for one
 * outside it.
 *
 * The chat surface's undo and review already speak vault-relative paths
 * (they resolve a `TFile` and go through the Vault API). Recording the
 * vault-relative form whenever it exists means a native edit to a note is
 * undoable and reviewable through exactly that path, with no branch —
 * the absolute form is reserved for the files that genuinely have no `TFile`,
 * where `isAbsoluteNativePath` is what tells the two apart again.
 */
export function toEditSummaryPath(
  absPath: string,
  vaultBasePath: string,
): string {
  if (!isInsideVault(absPath, vaultBasePath)) {
    return absPath
  }
  const relative = absPath.slice(
    vaultBasePath.replace(/[\\/]+$/, '').length + 1,
  )
  // The vault root itself is not a file; if it somehow arrives here there is
  // no relative path to return, so keep the absolute one.
  return relative.length === 0 ? absPath : relative.replace(/\\/g, '/')
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
