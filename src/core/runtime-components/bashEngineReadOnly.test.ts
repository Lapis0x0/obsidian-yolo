/**
 * Exercises the real `bash-engine` runtime component source (not a mock) to
 * verify the read-only session variant added to close the YOLO-45 known gap:
 * a module agent granted only the `vault-read` capability must not be able
 * to perform path writes (`mkdir`/`mv`/`rm`/`rmdir`) through the bash tool,
 * regardless of the configured approval tier.
 *
 * `entry.ts` lives under `runtime-components/`, which is outside Jest's
 * `roots` and the host `tsconfig.json`'s `include` (it's a separately
 * built/typechecked artifact — see `scripts/build-runtime-components.mjs`
 * and `runtime-components/tsconfig.json`), so this test imports it directly
 * by relative path. The component self-registers via
 * `globalThis.__yolo_register_runtime_component__` as a side effect of being
 * imported, so the stub must be installed before a *dynamic* import (a
 * static `import` would be hoisted above the stub installation).
 *
 * Importing entry.ts here pulls it into the host program for `tsc`, which
 * doesn't otherwise see `runtime-components/sdk.d.ts`'s ambient
 * `__yolo_register_runtime_component__` declaration — so this file restates
 * it (global augmentations merge across every file in a program regardless
 * of which file declares them) rather than adding that component-only file
 * to the host's `tsconfig.json`.
 */

export {}

type RegisteredDefinition = { id: string; create: () => unknown }

declare global {
  var __yolo_register_runtime_component__: (
    definition: RegisteredDefinition,
  ) => void
}

type FakeBashFsStat = { isFile: boolean; isDirectory: boolean }

type SessionExec = (
  command: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>

type BashEngineComponentApiLike = {
  createSession: (options: {
    fs: unknown
    confirmDangerousOperation: (
      kind: 'rm' | 'mv',
      targets: readonly string[],
    ) => Promise<boolean>
    readOnly?: boolean
  }) => { exec: SessionExec; dispose: () => void }
}

async function loadBashEngineComponent(): Promise<BashEngineComponentApiLike> {
  let captured: RegisteredDefinition | undefined
  globalThis.__yolo_register_runtime_component__ = (def) => {
    captured = def
  }
  await import('../../../runtime-components/bash-engine/src/entry')
  if (!captured) throw new Error('bash-engine component did not register')
  return captured.create() as BashEngineComponentApiLike
}

/** Minimal in-memory stand-in for `BashFsCallbacks`, instrumented with spies. */
function makeFakeFs(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles))
  const dirs = new Set<string>([''])
  const mkdir = jest.fn(async (p: string) => {
    dirs.add(p)
  })
  const rm = jest.fn(async (p: string) => {
    files.delete(p)
    return { targetKind: 'file' as const }
  })
  const mv = jest.fn(async (oldP: string, newP: string) => {
    const value = files.get(oldP)
    if (value !== undefined) {
      files.delete(oldP)
      files.set(newP, value)
    }
  })
  const fs = {
    async readFile(p: string) {
      const value = files.get(p)
      if (value === undefined) throw new Error(`ENOENT: no such file, '${p}'`)
      return value
    },
    async readFileBuffer(p: string) {
      return new TextEncoder().encode(files.get(p) ?? '')
    },
    async exists(p: string) {
      return files.has(p) || dirs.has(p)
    },
    async stat(p: string): Promise<FakeBashFsStat> {
      if (files.has(p)) return { isFile: true, isDirectory: false }
      if (dirs.has(p)) return { isFile: false, isDirectory: true }
      throw new Error(`ENOENT: no such file, '${p}'`)
    },
    mkdir,
    async readdir(p: string) {
      const prefix = p === '' ? '' : `${p}/`
      const names = new Set<string>()
      for (const filePath of files.keys()) {
        if (filePath.startsWith(prefix)) {
          const rest = filePath.slice(prefix.length)
          if (rest.length > 0 && !rest.includes('/')) names.add(rest)
        }
      }
      return [...names].map((name) => ({
        name,
        isFile: true,
        isDirectory: false,
      }))
    },
    rm,
    mv,
    getAllPaths() {
      return [...files.keys()]
    },
  }
  return { fs, files, mkdir, rm, mv }
}

describe('bash-engine read-only session', () => {
  const alwaysApprove = async () => true
  // The component self-registers on import (a module-level side effect), so
  // it must be loaded exactly once per test file and reused: Node/Jest cache
  // dynamic imports, and re-importing after the first call would resolve the
  // cached module without re-running the registration side effect.
  let component: BashEngineComponentApiLike

  beforeAll(async () => {
    component = await loadBashEngineComponent()
  })

  it('runs mkdir/mv/rm/rmdir normally when not read-only (baseline)', async () => {
    const { fs, mkdir, rm, mv } = makeFakeFs({ 'a.md': 'hello' })
    const session = component.createSession({
      fs,
      confirmDangerousOperation: alwaysApprove,
    })

    const mkdirResult = await session.exec('mkdir notes')
    expect(mkdirResult.exitCode).toBe(0)
    expect(mkdir).toHaveBeenCalledWith('notes', { recursive: false })

    const mvResult = await session.exec('mv a.md b.md')
    expect(mvResult.exitCode).toBe(0)
    expect(mv).toHaveBeenCalledWith('a.md', 'b.md')

    const rmResult = await session.exec('rm b.md')
    expect(rmResult.exitCode).toBe(0)
    expect(rm).toHaveBeenCalled()

    session.dispose()
  })

  it.each(['mkdir notes', 'rm a.md', 'mv a.md b.md', 'rmdir notes'])(
    'returns command-not-found for %s under a read-only session',
    async (command) => {
      const { fs, mkdir, rm, mv } = makeFakeFs({ 'a.md': 'hello' })
      const session = component.createSession({
        fs,
        confirmDangerousOperation: alwaysApprove,
        readOnly: true,
      })

      const result = await session.exec(command)

      expect(result.exitCode).toBe(127)
      expect(result.stderr.toLowerCase()).toContain('not found')
      // Layer 1: the write verb is unregistered, so the fs write callbacks
      // are never reached at all.
      expect(mkdir).not.toHaveBeenCalled()
      expect(rm).not.toHaveBeenCalled()
      expect(mv).not.toHaveBeenCalled()

      session.dispose()
    },
  )

  it('never consults confirmDangerousOperation under a read-only session', async () => {
    const { fs } = makeFakeFs({ 'a.md': 'hello' })
    const confirmDangerousOperation = jest.fn(async () => true)
    const session = component.createSession({
      fs,
      confirmDangerousOperation,
      readOnly: true,
    })

    await session.exec('rm a.md')
    await session.exec('mv a.md b.md')

    expect(confirmDangerousOperation).not.toHaveBeenCalled()
    session.dispose()
  })

  it('still allows read-heavy commands under a read-only session', async () => {
    const { fs } = makeFakeFs({ 'a.md': 'hello world' })
    const session = component.createSession({
      fs,
      confirmDangerousOperation: alwaysApprove,
      readOnly: true,
    })

    const catResult = await session.exec('cat a.md')
    expect(catResult.exitCode).toBe(0)
    expect(catResult.stdout).toContain('hello world')

    const lsResult = await session.exec('ls')
    expect(lsResult.exitCode).toBe(0)
    expect(lsResult.stdout).toContain('a.md')

    session.dispose()
  })

  // `ln -f` isn't a write verb we specifically exclude — it stays registered
  // in the read-only command set — but it removes an existing destination by
  // calling `fs.rm` internally before failing on the (always-rejected)
  // symlink step. This is the "unanticipated path" defense-in-depth layer 2
  // is for: confirm that even a command we didn't special-case can't reach
  // the write callback while read-only.
  it('resolves directory paths with trailing slashes against exact-match fs lookups', async () => {
    // Vault lookups are exact-string; path-browserify's normalize keeps
    // trailing slashes, so `ls "/vault/dir/"` used to ENOENT (exit 2).
    const { fs, files } = makeFakeFs({})
    const session = component.createSession({
      fs,
      confirmDangerousOperation: alwaysApprove,
    })
    expect((await session.exec('mkdir /vault/tmp')).exitCode).toBe(0)
    expect((await session.exec('mkdir /vault/tmp/mv测试')).exitCode).toBe(0)
    files.set('tmp/mv测试/note.md', 'x')

    const quoted = await session.exec('ls "/vault/tmp/mv测试/"')
    expect(quoted.exitCode).toBe(0)
    expect(quoted.stdout).toContain('note.md')

    const unquoted = await session.exec('ls /vault/tmp/mv测试/')
    expect(unquoted.exitCode).toBe(0)
    expect(unquoted.stdout).toContain('note.md')

    const cat = await session.exec('cat "/vault/tmp/mv测试/note.md"')
    expect(cat.exitCode).toBe(0)
    expect(cat.stdout).toBe('x')
  })

  it('blocks writes reached through unanticipated commands (ln -f) at the fs boundary', async () => {
    const { fs, rm } = makeFakeFs({ 'a.md': 'x', 'b.md': 'y' })

    const writableSession = component.createSession({
      fs,
      confirmDangerousOperation: alwaysApprove,
    })
    await writableSession.exec('ln -sf a.md b.md')
    expect(rm).toHaveBeenCalledWith('b.md', { force: true })
    writableSession.dispose()

    rm.mockClear()
    const readOnlySession = component.createSession({
      fs,
      confirmDangerousOperation: alwaysApprove,
      readOnly: true,
    })
    await readOnlySession.exec('ln -sf a.md b.md')
    expect(rm).not.toHaveBeenCalled()
    readOnlySession.dispose()
  })
})
