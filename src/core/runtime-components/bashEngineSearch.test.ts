/**
 * Exercises the real `bash-engine` runtime component source (not a mock) to
 * verify the custom `search` command: argument parsing, vault-relative scope
 * resolution, grep-style output formatting, and availability in read-only
 * sessions. See `bashEngineReadOnly.test.ts` for why the component is loaded
 * via dynamic import with a registration stub.
 */

export {}

type RegisteredDefinition = { id: string; create: () => unknown }

declare global {
  var __yolo_register_runtime_component__: (
    definition: RegisteredDefinition,
  ) => void
}

type SessionExec = (
  command: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>

type SearchResultEntry = {
  kind: 'file' | 'dir' | 'content'
  path: string
  startLine?: number
  endLine?: number
  page?: number
  snippet?: string
}

type SearchOutcome =
  | { status: 'success'; results: SearchResultEntry[]; notice?: string }
  | { status: 'error'; message: string }

type SearchCallback = (request: {
  query: string
  scopePath?: string
  maxResults: number
}) => Promise<SearchOutcome>

type BashEngineComponentApiLike = {
  createSession: (options: {
    fs: unknown
    confirmDangerousOperation: (
      kind: 'rm' | 'mv',
      targets: readonly string[],
    ) => Promise<boolean>
    search?: SearchCallback
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

/** Search never touches the fs callbacks, so an inert stub suffices. */
function makeInertFs() {
  return {
    async readFile(p: string): Promise<string> {
      throw new Error(`ENOENT: no such file, '${p}'`)
    },
    async readFileBuffer(): Promise<Uint8Array> {
      return new Uint8Array()
    },
    async exists(): Promise<boolean> {
      return false
    },
    async stat(p: string): Promise<never> {
      throw new Error(`ENOENT: no such file, '${p}'`)
    },
    async mkdir(): Promise<void> {},
    async readdir(): Promise<[]> {
      return []
    },
    async rm(): Promise<{ targetKind: 'file' }> {
      return { targetKind: 'file' }
    },
    async mv(): Promise<void> {},
    getAllPaths(): string[] {
      return []
    },
  }
}

describe('bash-engine search command', () => {
  const alwaysApprove = async () => true
  let component: BashEngineComponentApiLike

  beforeAll(async () => {
    component = await loadBashEngineComponent()
  })

  function createSession(
    search: SearchCallback | undefined,
    options: { readOnly?: boolean } = {},
  ) {
    return component.createSession({
      fs: makeInertFs(),
      confirmDangerousOperation: alwaysApprove,
      search,
      readOnly: options.readOnly,
    })
  }

  it('is command-not-found when the host provides no search callback', async () => {
    const session = createSession(undefined)
    const result = await session.exec('search foo')
    expect(result.exitCode).toBe(127)
    expect(result.stderr.toLowerCase()).toContain('not found')
    session.dispose()
  })

  it('passes query with default maxResults and formats grep-style lines', async () => {
    const search = jest.fn<
      Promise<SearchOutcome>,
      [Parameters<SearchCallback>[0]]
    >(async () => ({
      status: 'success',
      results: [
        {
          kind: 'content',
          path: 'notes/a.md',
          startLine: 3,
          endLine: 5,
          snippet: 'hello  world',
        },
        { kind: 'content', path: 'notes/b.md', startLine: 7, snippet: 's' },
        { kind: 'content', path: 'docs/c.pdf', page: 4, snippet: 'p' },
        { kind: 'file', path: 'notes/a.md' },
        { kind: 'dir', path: 'notes' },
      ],
    }))
    const session = createSession(search)

    const result = await session.exec('search "hello world"')

    expect(search).toHaveBeenCalledWith({
      query: 'hello world',
      scopePath: undefined,
      maxResults: 20,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(
      [
        '/vault/notes/a.md:3-5: hello world',
        '/vault/notes/b.md:7: s',
        '/vault/docs/c.pdf:p4: p',
        '/vault/notes/a.md',
        '/vault/notes/',
        '',
      ].join('\n'),
    )
    session.dispose()
  })

  it('parses -n and rejects invalid counts', async () => {
    const search = jest.fn<
      Promise<SearchOutcome>,
      [Parameters<SearchCallback>[0]]
    >(async () => ({
      status: 'success',
      results: [{ kind: 'file', path: 'a.md' }],
    }))
    const session = createSession(search)

    expect((await session.exec('search -n 5 topic')).exitCode).toBe(0)
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 5 }),
    )

    const invalid = await session.exec('search -n 0 topic')
    expect(invalid.exitCode).toBe(2)
    expect(search).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('resolves the path argument to a vault-relative scope', async () => {
    const search = jest.fn<
      Promise<SearchOutcome>,
      [Parameters<SearchCallback>[0]]
    >(async () => ({
      status: 'success',
      results: [{ kind: 'file', path: 'x' }],
    }))
    const session = createSession(search)

    // cwd defaults to /vault; trailing slash must not leak into the scope.
    await session.exec('search q "notes/sub/"')
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ scopePath: 'notes/sub' }),
    )

    // The vault mount itself means "whole vault".
    await session.exec('search q /vault')
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ scopePath: undefined }),
    )

    const outside = await session.exec('search q /elsewhere')
    expect(outside.exitCode).toBe(2)
    expect(outside.stderr).toContain('outside /vault')
    session.dispose()
  })

  it('requires a query and rejects extra arguments', async () => {
    const search = jest.fn<
      Promise<SearchOutcome>,
      [Parameters<SearchCallback>[0]]
    >(async () => ({ status: 'success', results: [] }))
    const session = createSession(search)

    const missing = await session.exec('search')
    expect(missing.exitCode).toBe(2)
    expect(missing.stderr).toContain('usage:')

    const extra = await session.exec('search one two three')
    expect(extra.exitCode).toBe(2)
    expect(extra.stderr).toContain('quote the query')
    expect(search).not.toHaveBeenCalled()
    session.dispose()
  })

  it('maps empty results to exit 1 and error outcomes to stderr', async () => {
    const outcomes: SearchOutcome[] = [
      { status: 'success', results: [] },
      { status: 'error', message: 'index unavailable' },
    ]
    const search: SearchCallback = async () =>
      outcomes.shift() ?? { status: 'success', results: [] }
    const session = createSession(search)

    const empty = await session.exec('search nothing')
    expect(empty.exitCode).toBe(1)
    expect(empty.stderr).toContain("no results for 'nothing'")

    const failed = await session.exec('search boom')
    expect(failed.exitCode).toBe(1)
    expect(failed.stderr).toContain('search: index unavailable')
    session.dispose()
  })

  it('prints the fallback notice on stderr while succeeding', async () => {
    const search: SearchCallback = async () => ({
      status: 'success',
      results: [{ kind: 'file', path: 'a.md' }],
      notice: 'RAG is not enabled. Fell back to keyword search.',
    })
    const session = createSession(search)

    const result = await session.exec('search topic')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('/vault/a.md')
    expect(result.stderr).toContain('Fell back to keyword search')
    session.dispose()
  })

  it('stays available in read-only sessions', async () => {
    const search: SearchCallback = async () => ({
      status: 'success',
      results: [{ kind: 'file', path: 'a.md' }],
    })
    const session = createSession(search, { readOnly: true })

    const result = await session.exec('search topic')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('/vault/a.md')
    session.dispose()
  })
})
