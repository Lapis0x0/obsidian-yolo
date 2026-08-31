import {
  Bash,
  type CommandName,
  type ExecResult,
  type FsStat,
  type IFileSystem,
  type ResolvedCommandContext,
  defineCommand,
  getCommandNames,
} from 'just-bash/browser'
import path from 'path-browserify'

type DirentLike = Readonly<{
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}>

// The component-facing API contract lives in host code
// (`src/core/runtime-components/contracts.ts`) so the host never needs to
// import this component's source. We re-declare the minimal shapes we need
// here instead of importing across the runtime-component boundary — the
// build's boundary check forbids importing `src/` from a component, and the
// host's types are intentionally independent of just-bash's types anyway.
type BashFsStat = Readonly<{
  isFile: boolean
  isDirectory: boolean
  mtimeMs: number
  size: number
}>
type BashFsDirentEntry = Readonly<{
  name: string
  isFile: boolean
  isDirectory: boolean
}>
type BashFsRmResult = Readonly<{ targetKind: 'file' | 'folder' }>
type BashFsCallbacks = Readonly<{
  readFile(vaultPath: string): Promise<string>
  readFileBuffer(vaultPath: string): Promise<Uint8Array>
  exists(vaultPath: string): Promise<boolean>
  stat(vaultPath: string): Promise<BashFsStat>
  mkdir(vaultPath: string, options?: { recursive?: boolean }): Promise<void>
  readdir(vaultPath: string): Promise<BashFsDirentEntry[]>
  rm(
    vaultPath: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<BashFsRmResult>
  mv(oldVaultPath: string, newVaultPath: string): Promise<void>
  getAllPaths(): string[]
}>
type BashDangerousOperationKind = 'rm' | 'mv'
type BashConfirmDangerousOperation = (
  kind: BashDangerousOperationKind,
  targets: readonly string[],
) => Promise<boolean>
type BashSearchResultEntry = Readonly<{
  kind: 'file' | 'dir' | 'content'
  path: string
  startLine?: number
  endLine?: number
  page?: number
  snippet?: string
}>
type BashSearchOutcome =
  | Readonly<{
      status: 'success'
      results: readonly BashSearchResultEntry[]
      notice?: string
    }>
  | Readonly<{ status: 'error'; message: string }>
type BashSearchCallback = (
  request: Readonly<{
    query: string
    scopePath?: string
    maxResults: number
    knowledgeBase?: string
  }>,
) => Promise<BashSearchOutcome>
type BashSessionOptions = Readonly<{
  fs: BashFsCallbacks
  confirmDangerousOperation: BashConfirmDangerousOperation
  /** See `BashSessionOptions.search` in `src/core/runtime-components/contracts.ts`. */
  search?: BashSearchCallback
  cwd?: string
  signal?: AbortSignal
  /** See `BashSessionOptions.readOnly` in `src/core/runtime-components/contracts.ts`. */
  readOnly?: boolean
}>
type BashSessionResult = Readonly<{
  stdout: string
  stderr: string
  exitCode: number
}>
type BashSession = Readonly<{
  exec(command: string): Promise<BashSessionResult>
  dispose(): void
}>
type BashEngineComponentApi = Readonly<{
  createSession(options: BashSessionOptions): BashSession
  dispose(): void
}>

const VAULT_MOUNT = '/vault'
const DEFAULT_CWD = '/vault'
const NOT_A_CONTENT_WRITE_TOOL_MESSAGE =
  'This filesystem is read-only for content. Use fs_edit or fs_write to modify file contents.'
const NOT_SUPPORTED_MESSAGE =
  'Symlinks and hard links are not supported in this filesystem.'
const READ_ONLY_SESSION_MESSAGE =
  'This bash session is read-only. mkdir/mv/rm are not available here.'

// gzip/gunzip/zcat/tar pull in a `node:zlib` import that only resolves via
// the build's zlib stub (see scripts/build-runtime-components.mjs) and would
// throw at call time anyway; html-to-markdown needs network fetch which this
// session never configures. rm/mv/rmdir are replaced below by
// approval-aware custom commands, so the built-ins are excluded to avoid any
// ambiguity about which implementation runs.
const EXCLUDED_BUILTIN_COMMANDS = new Set<string>([
  'html-to-markdown',
  'gzip',
  'gunzip',
  'zcat',
  'tar',
  'rm',
  'mv',
  'rmdir',
])

const ALLOWED_COMMANDS = getCommandNames().filter(
  (name) => !EXCLUDED_BUILTIN_COMMANDS.has(name),
) as CommandName[]

// Read-only sessions (see `BashSessionOptions.readOnly`) additionally drop
// `mkdir` — the one remaining built-in that writes a vault path directly —
// on top of the rm/mv/rmdir already excluded above. Combined with omitting
// the custom rm/mv/rmdir commands in `createSession`, no command name that
// reaches `fs.mkdir`/`fs.rm`/`fs.mv` is registered at all: the model gets
// "command not found" rather than a permission error.
const READ_ONLY_EXCLUDED_COMMANDS = new Set<string>([
  ...EXCLUDED_BUILTIN_COMMANDS,
  'mkdir',
])

const READ_ONLY_ALLOWED_COMMANDS = getCommandNames().filter(
  (name) => !READ_ONLY_EXCLUDED_COMMANDS.has(name),
) as CommandName[]

type PathClass =
  | { kind: 'root' }
  | { kind: 'vault'; relative: string }
  | { kind: 'outside' }

// path-browserify's POSIX normalize keeps trailing slashes ('/a/b/' stays
// '/a/b/'), but vault lookups are exact-string, so '/vault/x/' must resolve
// to the same entry as '/vault/x'.
function normalizeNoTrailingSlash(rawPath: string): string {
  const normalized = path.normalize(rawPath) || '/'
  if (normalized === '/') return normalized
  return normalized.replace(/\/+$/, '') || '/'
}

function classify(rawPath: string): PathClass {
  const normalized = normalizeNoTrailingSlash(rawPath)
  if (normalized === '/') return { kind: 'root' }
  if (normalized === VAULT_MOUNT) return { kind: 'vault', relative: '' }
  if (normalized.startsWith(`${VAULT_MOUNT}/`)) {
    return {
      kind: 'vault',
      relative: normalized.slice(VAULT_MOUNT.length + 1),
    }
  }
  return { kind: 'outside' }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Owns path mounting (`/` -> synthetic root containing `vault`, `/vault/*`
 * -> the host vault) and the danger-approval boundary for `rm`/`mv`. Every
 * write path — including ones reached through built-ins we didn't
 * anticipate (e.g. `ln -f` removing an existing destination) — funnels
 * through `rm`/`mv` here, so this is the structural enforcement point, not
 * just the custom `rm`/`mv`/`rmdir` commands below.
 *
 * When `readOnly` is set, `mkdir`/`rm`/`mv` (gated and ungated alike) throw
 * immediately, before ever consulting `confirm` or calling out to `fs`. This
 * is the second of two layers for a read-only session — the first being
 * `createSession` never registering a command name that reaches these
 * methods at all (see `READ_ONLY_ALLOWED_COMMANDS`). Guarding here too means
 * a command we didn't anticipate reaching `fs.mkdir`/`fs.rm`/`fs.mv` (the
 * same `ln -f` class of case referenced above) is still denied structurally.
 */
class SessionFs {
  constructor(
    private readonly fs: BashFsCallbacks,
    private readonly confirm: BashConfirmDangerousOperation,
    private readonly readOnly: boolean = false,
  ) {}

  resolvePath(base: string, target: string): string {
    const joined = target.startsWith('/') ? target : path.join(base, target)
    return normalizeNoTrailingSlash(joined)
  }

  async readFile(target: string): Promise<string> {
    const c = classify(target)
    if (c.kind !== 'vault' || c.relative === '') {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${target}'`,
      )
    }
    return this.fs.readFile(c.relative)
  }

  async readFileBuffer(target: string): Promise<Uint8Array> {
    const c = classify(target)
    if (c.kind !== 'vault' || c.relative === '') {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${target}'`,
      )
    }
    return this.fs.readFileBuffer(c.relative)
  }

  async exists(target: string): Promise<boolean> {
    const c = classify(target)
    if (c.kind === 'root') return true
    if (c.kind === 'outside') return false
    if (c.relative === '') return true
    return this.fs.exists(c.relative)
  }

  async stat(target: string): Promise<FsStat> {
    const c = classify(target)
    if (c.kind === 'root' || (c.kind === 'vault' && c.relative === '')) {
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o755,
        size: 0,
        mtime: new Date(0),
      }
    }
    if (c.kind === 'outside') {
      throw new Error(`ENOENT: no such file or directory, stat '${target}'`)
    }
    const stat = await this.fs.stat(c.relative)
    return {
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      isSymbolicLink: false,
      mode: stat.isDirectory ? 0o755 : 0o644,
      size: stat.size,
      mtime: new Date(stat.mtimeMs),
    }
  }

  async readdir(target: string): Promise<string[]> {
    const c = classify(target)
    if (c.kind === 'root') return ['vault']
    if (c.kind === 'outside') {
      throw new Error(`ENOENT: no such file or directory, scandir '${target}'`)
    }
    const entries = await this.fs.readdir(c.relative)
    return entries.map((entry) => entry.name)
  }

  async readdirWithFileTypes(target: string): Promise<DirentLike[]> {
    const c = classify(target)
    if (c.kind === 'root') {
      return [
        {
          name: 'vault',
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
        },
      ]
    }
    if (c.kind === 'outside') {
      throw new Error(`ENOENT: no such file or directory, scandir '${target}'`)
    }
    const entries = await this.fs.readdir(c.relative)
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile,
      isDirectory: entry.isDirectory,
      isSymbolicLink: false,
    }))
  }

  async mkdir(
    target: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    if (this.readOnly) throw new Error(READ_ONLY_SESSION_MESSAGE)
    const c = classify(target)
    if (c.kind !== 'vault' || c.relative === '') {
      throw new Error(`EEXIST: file already exists, mkdir '${target}'`)
    }
    await this.fs.mkdir(c.relative, options)
  }

  /** Gated entry point used by any command that reaches `fs.rm` directly. */
  async rm(
    target: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    if (this.readOnly) throw new Error(READ_ONLY_SESSION_MESSAGE)
    const c = classify(target)
    if (c.kind !== 'vault' || c.relative === '') {
      throw new Error(`EROFS: read-only file system, unlink '${target}'`)
    }
    const approved = await this.confirm('rm', [target])
    if (!approved) throw new Error('operation denied by user')
    await this.fs.rm(c.relative, options)
  }

  /** Gated entry point used by any command that reaches `fs.mv` directly. */
  async mv(oldTarget: string, newTarget: string): Promise<void> {
    if (this.readOnly) throw new Error(READ_ONLY_SESSION_MESSAGE)
    const oldClass = classify(oldTarget)
    const newClass = classify(newTarget)
    if (
      oldClass.kind !== 'vault' ||
      oldClass.relative === '' ||
      newClass.kind !== 'vault' ||
      newClass.relative === ''
    ) {
      throw new Error(`EROFS: read-only file system, rename '${oldTarget}'`)
    }
    const approved = await this.confirm('mv', [`${oldTarget} -> ${newTarget}`])
    if (!approved) throw new Error('operation denied by user')
    await this.fs.mv(oldClass.relative, newClass.relative)
  }

  /** Ungated: only called after the calling command already confirmed. */
  async rmRaw(
    target: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<BashFsRmResult> {
    if (this.readOnly) throw new Error(READ_ONLY_SESSION_MESSAGE)
    const c = classify(target)
    if (c.kind !== 'vault' || c.relative === '') {
      throw new Error(`EROFS: read-only file system, unlink '${target}'`)
    }
    return this.fs.rm(c.relative, options)
  }

  /** Ungated: only called after the calling command already confirmed. */
  async mvRaw(oldTarget: string, newTarget: string): Promise<void> {
    if (this.readOnly) throw new Error(READ_ONLY_SESSION_MESSAGE)
    const oldClass = classify(oldTarget)
    const newClass = classify(newTarget)
    if (
      oldClass.kind !== 'vault' ||
      oldClass.relative === '' ||
      newClass.kind !== 'vault' ||
      newClass.relative === ''
    ) {
      throw new Error(`EROFS: read-only file system, rename '${oldTarget}'`)
    }
    await this.fs.mv(oldClass.relative, newClass.relative)
  }

  confirmBatch(
    kind: BashDangerousOperationKind,
    targets: readonly string[],
  ): Promise<boolean> {
    return this.confirm(kind, targets)
  }

  getAllPaths(): string[] {
    return this.fs
      .getAllPaths()
      .map((relative) =>
        relative === '' ? VAULT_MOUNT : `${VAULT_MOUNT}/${relative}`,
      )
  }

  toIFileSystem(): IFileSystem {
    // Arrow functions below close over the enclosing method's `this`
    // lexically — no alias needed, unlike a `function` expression would.
    return {
      readFile: (target) => this.readFile(target),
      readFileBuffer: (target) => this.readFileBuffer(target),
      writeFile: () =>
        Promise.reject(new Error(NOT_A_CONTENT_WRITE_TOOL_MESSAGE)),
      appendFile: () =>
        Promise.reject(new Error(NOT_A_CONTENT_WRITE_TOOL_MESSAGE)),
      exists: (target) => this.exists(target),
      stat: (target) => this.stat(target),
      mkdir: (target, options) => this.mkdir(target, options),
      readdir: (target) => this.readdir(target),
      readdirWithFileTypes: (target) => this.readdirWithFileTypes(target),
      rm: (target, options) => this.rm(target, options),
      cp: () => Promise.reject(new Error(NOT_A_CONTENT_WRITE_TOOL_MESSAGE)),
      mv: (oldTarget, newTarget) => this.mv(oldTarget, newTarget),
      resolvePath: (base, target) => this.resolvePath(base, target),
      getAllPaths: () => this.getAllPaths(),
      chmod: async (target) => {
        // Vault entries have no POSIX mode to persist; accept silently once
        // the target is confirmed to exist so `chmod` doesn't spuriously
        // fail scripts that probe permissions before writing elsewhere.
        if (!(await this.exists(target))) {
          throw new Error(
            `ENOENT: no such file or directory, chmod '${target}'`,
          )
        }
      },
      symlink: () => Promise.reject(new Error(NOT_SUPPORTED_MESSAGE)),
      link: () => Promise.reject(new Error(NOT_SUPPORTED_MESSAGE)),
      readlink: () => Promise.reject(new Error(NOT_SUPPORTED_MESSAGE)),
      lstat: (target) => this.stat(target),
      realpath: async (target) => {
        if (!(await this.exists(target))) {
          throw new Error(
            `ENOENT: no such file or directory, realpath '${target}'`,
          )
        }
        return normalizeNoTrailingSlash(target)
      },
      // Vault mtimes aren't independently settable through the public Vault
      // API; `touch` on an existing file becomes a harmless no-op instead of
      // failing scripts that only use it for existence-priming.
      utimes: async () => undefined,
    }
  }
}

type FlagSpec = Record<string, string>

function parseFlags(
  args: string[],
  spec: FlagSpec,
): { flags: Record<string, boolean>; positional: string[] } {
  const flags: Record<string, boolean> = {}
  const positional: string[] = []
  let sawDoubleDash = false
  for (const arg of args) {
    if (!sawDoubleDash && arg === '--') {
      sawDoubleDash = true
      continue
    }
    if (!sawDoubleDash && arg.length > 1 && arg[0] === '-') {
      if (arg.startsWith('--')) {
        const name = spec[arg.slice(2)]
        if (name) flags[name] = true
        continue
      }
      for (const ch of arg.slice(1)) {
        const name = spec[ch]
        if (name) flags[name] = true
      }
      continue
    }
    positional.push(arg)
  }
  return { flags, positional }
}

function createRmLikeCommand(
  name: 'rm' | 'rmdir',
  sessionOf: (ctx: ResolvedCommandContext) => SessionFs,
) {
  return defineCommand(name, async (args, ctx): Promise<ExecResult> => {
    const session = sessionOf(ctx)
    const { flags, positional } =
      name === 'rm'
        ? parseFlags(args, {
            r: 'recursive',
            R: 'recursive',
            recursive: 'recursive',
            f: 'force',
            force: 'force',
            v: 'verbose',
            verbose: 'verbose',
          })
        : parseFlags(args, {})
    if (positional.length === 0) {
      return flags.force
        ? { stdout: '', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: `${name}: missing operand\n`, exitCode: 1 }
    }
    const targets = positional.map((raw) => ({
      raw,
      abs: session.resolvePath(ctx.cwd, raw),
    }))
    const approved = await session.confirmBatch(
      'rm',
      targets.map((t) => t.abs),
    )
    if (!approved) {
      return { stdout: '', stderr: 'operation denied by user\n', exitCode: 1 }
    }
    let stdout = ''
    let stderr = ''
    let exitCode = 0
    for (const target of targets) {
      try {
        if (name === 'rmdir') {
          const stat = await session.stat(target.abs)
          if (!stat.isDirectory) {
            stderr += `rmdir: failed to remove '${target.raw}': Not a directory\n`
            exitCode = 1
            continue
          }
          const entries = await session.readdir(target.abs)
          if (entries.length > 0) {
            stderr += `rmdir: failed to remove '${target.raw}': Directory not empty\n`
            exitCode = 1
            continue
          }
          await session.rmRaw(target.abs, { recursive: false, force: false })
          continue
        }
        const stat = await session.stat(target.abs)
        if (stat.isDirectory && !flags.recursive) {
          stderr += `rm: cannot remove '${target.raw}': Is a directory\n`
          exitCode = 1
          continue
        }
        await session.rmRaw(target.abs, {
          recursive: flags.recursive ?? false,
          force: flags.force ?? false,
        })
        if (flags.verbose) stdout += `removed '${target.raw}'\n`
      } catch (error) {
        if (!flags.force) {
          const message = errorMessage(error)
          stderr +=
            message.includes('No such file') || message.includes('ENOENT')
              ? `${name}: cannot remove '${target.raw}': No such file or directory\n`
              : `${name}: cannot remove '${target.raw}': ${message}\n`
          exitCode = 1
        }
      }
    }
    return { stdout, stderr, exitCode }
  })
}

function createMvCommand(
  sessionOf: (ctx: ResolvedCommandContext) => SessionFs,
) {
  return defineCommand('mv', async (args, ctx): Promise<ExecResult> => {
    const session = sessionOf(ctx)
    const { positional } = parseFlags(args, { f: 'force', force: 'force' })
    if (positional.length < 2) {
      return {
        stdout: '',
        stderr: 'mv: missing file operand\n',
        exitCode: 1,
      }
    }
    const destRaw = positional[positional.length - 1]
    const sourceRaws = positional.slice(0, -1)
    const destAbs = session.resolvePath(ctx.cwd, destRaw)
    let destIsDir = false
    try {
      destIsDir = (await session.stat(destAbs)).isDirectory
    } catch {
      destIsDir = false
    }
    if (sourceRaws.length > 1 && !destIsDir) {
      return {
        stdout: '',
        stderr: `mv: target '${destRaw}' is not a directory\n`,
        exitCode: 1,
      }
    }
    const moves = sourceRaws.map((raw) => {
      const srcAbs = session.resolvePath(ctx.cwd, raw)
      const targetAbs = destIsDir
        ? session.resolvePath(destAbs, path.basename(srcAbs))
        : destAbs
      return { raw, srcAbs, targetAbs }
    })
    const approved = await session.confirmBatch(
      'mv',
      moves.map((m) => `${m.srcAbs} -> ${m.targetAbs}`),
    )
    if (!approved) {
      return { stdout: '', stderr: 'operation denied by user\n', exitCode: 1 }
    }
    let stdout = ''
    let stderr = ''
    let exitCode = 0
    for (const move of moves) {
      try {
        if (await session.exists(move.targetAbs)) {
          stderr += `mv: cannot move '${move.raw}' to '${move.targetAbs}': File exists\n`
          exitCode = 1
          continue
        }
        await session.mvRaw(move.srcAbs, move.targetAbs)
        stdout += `renamed '${move.raw}' -> '${move.targetAbs}'\n`
      } catch (error) {
        stderr += `mv: cannot move '${move.raw}': ${errorMessage(error)}\n`
        exitCode = 1
      }
    }
    return { stdout, stderr, exitCode }
  })
}

const SEARCH_MAX_RESULTS_DEFAULT = 20
const SEARCH_MAX_RESULTS_CAP = 100
const SEARCH_USAGE = 'usage: search [-n N] [--kb NAME] "query" [path]\n'

function formatSearchLine(entry: BashSearchResultEntry): string {
  const abs = entry.path === '' ? VAULT_MOUNT : `${VAULT_MOUNT}/${entry.path}`
  if (entry.kind === 'dir') return `${abs}/`
  if (entry.kind === 'file') return abs
  const loc =
    entry.page !== undefined
      ? `p${entry.page}`
      : entry.startLine !== undefined
        ? entry.endLine !== undefined && entry.endLine > entry.startLine
          ? `${entry.startLine}-${entry.endLine}`
          : `${entry.startLine}`
        : ''
  const snippet = (entry.snippet ?? '').replace(/\s+/g, ' ').trim()
  return loc ? `${abs}:${loc}: ${snippet}` : `${abs}: ${snippet}`
}

/**
 * Custom `search` command: semantic (hybrid RAG + keyword) vault retrieval,
 * delegated entirely to the host callback. Output is grep-shaped
 * (`/vault/path:line: snippet`, one hit per line) so results compose with
 * pipes the same way grep's do. Registered in read-only sessions too —
 * search is a read.
 */
function createSearchCommand(
  search: BashSearchCallback,
  sessionOf: (ctx: ResolvedCommandContext) => SessionFs,
) {
  return defineCommand('search', async (args, ctx): Promise<ExecResult> => {
    let maxResults = SEARCH_MAX_RESULTS_DEFAULT
    let knowledgeBase: string | undefined
    const positional: string[] = []
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '-n' || arg === '--max-results') {
        const raw = args[i + 1]
        i += 1
        const parsed = Number(raw)
        if (!Number.isInteger(parsed) || parsed < 1) {
          return {
            stdout: '',
            stderr: `search: invalid result count '${raw ?? ''}'\n${SEARCH_USAGE}`,
            exitCode: 2,
          }
        }
        maxResults = Math.min(parsed, SEARCH_MAX_RESULTS_CAP)
        continue
      }
      if (arg === '--kb') {
        const raw = args[i + 1]
        i += 1
        if (!raw || raw.trim() === '') {
          return {
            stdout: '',
            stderr: `search: --kb requires a knowledge base name\n${SEARCH_USAGE}`,
            exitCode: 2,
          }
        }
        knowledgeBase = raw
        continue
      }
      if (arg === '--') {
        positional.push(...args.slice(i + 1))
        break
      }
      if (arg.length > 1 && arg[0] === '-') {
        return {
          stdout: '',
          stderr: `search: unknown option '${arg}'\n${SEARCH_USAGE}`,
          exitCode: 2,
        }
      }
      positional.push(arg)
    }
    if (positional.length === 0 || positional[0].trim() === '') {
      return { stdout: '', stderr: SEARCH_USAGE, exitCode: 2 }
    }
    if (positional.length > 2) {
      return {
        stdout: '',
        stderr: `search: too many arguments (quote the query)\n${SEARCH_USAGE}`,
        exitCode: 2,
      }
    }
    const query = positional[0]
    let scopePath: string | undefined
    if (positional.length === 2) {
      const abs = sessionOf(ctx).resolvePath(ctx.cwd, positional[1])
      const c = classify(abs)
      if (c.kind === 'outside') {
        return {
          stdout: '',
          stderr: `search: path is outside ${VAULT_MOUNT}: '${positional[1]}'\n`,
          exitCode: 2,
        }
      }
      // Root and the vault mount itself both mean "whole vault".
      scopePath =
        c.kind === 'vault' && c.relative !== '' ? c.relative : undefined
    }

    const outcome = await search({
      query,
      scopePath,
      maxResults,
      knowledgeBase,
    })
    if (outcome.status === 'error') {
      return { stdout: '', stderr: `search: ${outcome.message}\n`, exitCode: 1 }
    }
    const notice = outcome.notice ? `search: ${outcome.notice}\n` : ''
    if (outcome.results.length === 0) {
      // Mirror grep: no matches is exit 1, distinct from usage/runtime errors.
      return {
        stdout: '',
        stderr: `${notice}search: no results for '${query}'\n`,
        exitCode: 1,
      }
    }
    return {
      stdout: `${outcome.results.map(formatSearchLine).join('\n')}\n`,
      stderr: notice,
      exitCode: 0,
    }
  })
}

globalThis.__yolo_register_runtime_component__({
  id: 'bash-engine',
  create(): BashEngineComponentApi {
    let disposed = false
    return Object.freeze({
      createSession(options: BashSessionOptions): BashSession {
        if (disposed) throw new Error('Bash engine is disposed')
        const readOnly = options.readOnly ?? false
        const session = new SessionFs(
          options.fs,
          options.confirmDangerousOperation,
          readOnly,
        )
        const sessionOf = () => session
        const bash = new Bash({
          fs: session.toIFileSystem(),
          cwd: options.cwd ?? DEFAULT_CWD,
          commands: readOnly ? READ_ONLY_ALLOWED_COMMANDS : ALLOWED_COMMANDS,
          // Read-only sessions omit the rm/mv/rmdir custom commands entirely
          // (on top of `mkdir` already missing from READ_ONLY_ALLOWED_COMMANDS
          // above) so all four write verbs come back "command not found"
          // rather than reaching SessionFs's approval/fs plumbing at all.
          // `search` is a read, so it stays available in both variants.
          customCommands: [
            ...(options.search
              ? [createSearchCommand(options.search, sessionOf)]
              : []),
            ...(readOnly
              ? []
              : [
                  createRmLikeCommand('rm', sessionOf),
                  createRmLikeCommand('rmdir', sessionOf),
                  createMvCommand(sessionOf),
                ]),
          ],
          executionLimits: {
            maxExecutionTimeMs: 30_000,
            maxOutputSize: 2 * 1024 * 1024,
          },
        })
        let sessionDisposed = false
        return Object.freeze({
          async exec(command: string): Promise<BashSessionResult> {
            if (sessionDisposed) throw new Error('Bash session is disposed')
            const result = await bash.exec(command, { signal: options.signal })
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            }
          },
          dispose(): void {
            sessionDisposed = true
          },
        })
      },
      dispose(): void {
        disposed = true
      },
    })
  },
})
