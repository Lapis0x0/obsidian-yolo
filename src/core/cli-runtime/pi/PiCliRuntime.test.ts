import type { App } from 'obsidian'

import type { CliRuntimeEvent } from '../types'

import { PiCliRuntime } from './PiCliRuntime'
import type { PiProcessExitListener, PiProcessLike } from './process'

jest.mock('./resolve-command', () => ({
  resolvePiCommand: async () => ({ command: 'pi' }),
}))
jest.mock('../login-shell-env', () => ({
  loadLoginShellEnvironment: async () => ({}),
}))
jest.mock('../cli-path-override', () => ({
  getCliPathOverride: () => undefined,
}))
jest.mock('../../../utils/platform/desktopNodeModule', () => ({
  loadDesktopNodeModule: async (specifier: string) => {
    switch (specifier) {
      /* eslint-disable @typescript-eslint/no-require-imports, import/no-nodejs-modules -- stands in for the desktop-only loader this mock replaces; jest.mock's factory is hoisted above imports, so it cannot await a dynamic import */
      case 'node:fs/promises':
        return require('node:fs/promises')
      case 'node:path':
        return require('node:path')
      /* eslint-enable @typescript-eslint/no-require-imports, import/no-nodejs-modules */
      default:
        throw new Error(`Unexpected desktop module: ${specifier}`)
    }
  },
}))
jest.mock('./process')

/**
 * A scriptable fake `pi --mode rpc` subprocess: request `type`s with a
 * registered handler get an automatic success response on the next
 * microtask. Registration order relative to a request's arrival does not
 * matter — a request that arrives before its handler is registered is
 * queued and answered the moment `registerHandler` runs (real `pi` startup
 * is itself asynchronous, so the runtime's own requests routinely reach the
 * fake process before a test has had a chance to register a handler).
 */
class FakePiProcess implements PiProcessLike {
  readonly writes: Record<string, unknown>[] = []
  private readonly handlers = new Map<
    string,
    (payload: Record<string, unknown>) => unknown
  >()
  private readonly pendingByType = new Map<string, Record<string, unknown>[]>()
  shutdownCalled = false
  private dataListener: ((chunk: string) => void) | null = null
  private exitListener: PiProcessExitListener | null = null

  registerHandler(
    type: string,
    fn: (payload: Record<string, unknown>) => unknown,
  ): void {
    this.handlers.set(type, fn)
    const queued = this.pendingByType.get(type)
    if (!queued) return
    this.pendingByType.delete(type)
    for (const record of queued)
      this.respond(type, record.id as string, fn(record))
  }

  write(text: string): void {
    const record = JSON.parse(text) as Record<string, unknown>
    this.writes.push(record)
    const type = record.type as string
    const id = record.id
    if (typeof id !== 'string') return // fire-and-forget, e.g. `abort`
    const handler = this.handlers.get(type)
    if (!handler) {
      const queue = this.pendingByType.get(type) ?? []
      queue.push(record)
      this.pendingByType.set(type, queue)
      return
    }
    this.respond(type, id, handler(record))
  }

  private respond(type: string, id: string, data: unknown): void {
    queueMicrotask(() =>
      this.emitLine({
        type: 'response',
        command: type,
        success: true,
        data,
        id,
      }),
    )
  }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListener = listener
    return () => {
      this.dataListener = null
    }
  }

  onExit(listener: PiProcessExitListener): () => void {
    this.exitListener = listener
    return () => {
      this.exitListener = null
    }
  }

  getStderrSnapshot(): string {
    return ''
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true
    this.emitExit()
  }

  emitChunk(text: string): void {
    this.dataListener?.(text)
  }

  emitLine(record: unknown): void {
    this.emitChunk(`${JSON.stringify(record)}\n`)
  }

  emitExit(
    code: number | null = 0,
    signal: NodeJS.Signals | null = null,
  ): void {
    this.exitListener?.(code, signal)
  }

  requestsOf(type: string): Record<string, unknown>[] {
    return this.writes.filter((write) => write.type === type)
  }
}

const startedProcesses: FakePiProcess[] = []

const createRuntime = (): PiCliRuntime =>
  new PiCliRuntime({ app: {} as App, vaultPath: '/vault' })

const collectEvents = (runtime: PiCliRuntime): CliRuntimeEvent[] => {
  const events: CliRuntimeEvent[] = []
  runtime.subscribe((event) => events.push(event))
  return events
}

beforeEach(async () => {
  startedProcesses.length = 0
  const { PiSubprocess } = (await import('./process')) as unknown as {
    PiSubprocess: { start: jest.Mock }
  }
  PiSubprocess.start = jest.fn(async () => {
    const process = new FakePiProcess()
    startedProcesses.push(process)
    return process
  })
})

describe('PiCliRuntime — session binding on sendTurn', () => {
  it('awaits session binding before resolving, for a brand-new session', async () => {
    const runtime = createRuntime()
    const events = collectEvents(runtime)
    await runtime.ensureReady({})
    const process = startedProcesses[0]
    process.registerHandler('prompt', () => undefined)
    process.registerHandler('get_state', () => ({ sessionId: 'sess-1' }))

    await runtime.sendTurn({ content: 'hi' })

    // The caller (`cliChatIntegration.submitCliComposerTurn`) checks for a
    // bound session immediately after `sendTurn()` resolves — binding must
    // already have happened, not merely been kicked off.
    expect(events).toContainEqual({
      type: 'session_bound',
      ref: { runtimeId: 'pi', nativeSessionId: 'sess-1' },
    })
    await runtime.dispose()
  })

  it('retries get_state a bounded number of times before giving up', async () => {
    const runtime = createRuntime()
    const events = collectEvents(runtime)
    await runtime.ensureReady({})
    const process = startedProcesses[0]
    process.registerHandler('prompt', () => undefined)
    let getStateCalls = 0
    process.registerHandler('get_state', () => {
      getStateCalls += 1
      // No identity on the first two attempts — pi hasn't materialized the
      // session file yet — then succeeds on the third.
      return getStateCalls < 3 ? {} : { sessionId: 'sess-1' }
    })

    await runtime.sendTurn({ content: 'hi' })

    expect(getStateCalls).toBe(3)
    expect(events).toContainEqual({
      type: 'session_bound',
      ref: { runtimeId: 'pi', nativeSessionId: 'sess-1' },
    })
    await runtime.dispose()
  }, 10_000)
})

describe('PiCliRuntime — fatal transport recovery', () => {
  it('clears the active handle on a fatal error so the next ensureReady respawns', async () => {
    const runtime = createRuntime()
    const events = collectEvents(runtime)
    await runtime.ensureReady({})
    expect(startedProcesses).toHaveLength(1)

    startedProcesses[0].emitExit(1, null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      events.some(
        (event) => event.type === 'run_state' && event.state === 'error',
      ),
    ).toBe(true)

    // A second `ensureReady()` for the same (no-session) target must spawn a
    // fresh process rather than reusing the dead one — reuse would leave
    // every subsequent request permanently rejected by the stale fatal error.
    await runtime.ensureReady({})
    expect(startedProcesses).toHaveLength(2)
    await runtime.dispose()
  })
})

describe('PiCliRuntime — dispose racing ensureReady', () => {
  it('shuts down the process spawned after dispose() instead of leaking it', async () => {
    const runtime = createRuntime()
    let releaseSpawn: (() => void) | undefined
    const { PiSubprocess } = (await import('./process')) as unknown as {
      PiSubprocess: { start: jest.Mock }
    }
    PiSubprocess.start = jest.fn(
      () =>
        new Promise<FakePiProcess>((resolve) => {
          releaseSpawn = () => {
            const process = new FakePiProcess()
            startedProcesses.push(process)
            resolve(process)
          }
        }),
    )

    const ensureReadyPromise = runtime.ensureReady({})
    // `dispose()` races the in-flight spawn: at this point `activeHandle` is
    // still null (ensureReady hasn't even reached `PiSubprocess.start()`
    // yet — it awaits the command-resolution chain first), so dispose()
    // itself finds nothing to shut down.
    const disposePromise = runtime.dispose()
    await disposePromise

    // Let ensureReady's chain actually progress to (and past) the
    // `PiSubprocess.start()` call before releasing the spawn.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(releaseSpawn).toBeDefined()
    releaseSpawn?.()

    await expect(ensureReadyPromise).rejects.toThrow(/disposed/)

    // Confirm ensureReady's post-dispose check actually shut down the
    // process it just spawned rather than leaking it.
    expect(startedProcesses[0].shutdownCalled).toBe(true)
  })
})

describe('PiCliRuntime — model configuration restoration', () => {
  it('restores the current provider/model from get_state instead of defaulting to the catalog head, and applies provider+modelId on set_model', async () => {
    const runtime = createRuntime()
    // `ensureReady` on a resumed session binds synchronously via its own
    // `get_state` call, so the handler must exist before it runs.
    const readyPromise = runtime.ensureReady({
      sessionRef: { runtimeId: 'pi', nativeSessionId: 'sess-1' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const process = startedProcesses[0]
    process.registerHandler('get_state', () => ({
      sessionId: 'sess-1',
      model: { id: 'gpt-5', provider: 'openai' },
      thinkingLevel: 'high',
    }))
    await readyPromise

    const configuration = await runtime.getConfiguration([
      {
        id: 'openai/gpt-5',
        label: 'GPT-5',
        reasoningEfforts: [{ id: 'high' }],
      },
      {
        id: 'anthropic/claude-sonnet-4',
        label: 'Claude Sonnet 4',
        reasoningEfforts: [{ id: 'high' }],
      },
    ])

    expect(configuration.modelId).toBe('openai/gpt-5')
    expect(configuration.reasoningEffort).toBe('high')

    process.registerHandler('prompt', () => undefined)
    await runtime.sendTurn({ content: 'hi' })

    // Already applied via restoration — sendTurn must not issue a redundant
    // (or, pre-fix, wrong-catalog-head) set_model call.
    expect(process.requestsOf('set_model')).toHaveLength(0)
    await runtime.dispose()
  })

  it('sends {provider, modelId} to set_model when the user picks a different model', async () => {
    const runtime = createRuntime()
    await runtime.ensureReady({})
    const process = startedProcesses[0]
    process.registerHandler('set_model', () => undefined)
    process.registerHandler('prompt', () => undefined)
    process.registerHandler('get_state', () => ({ sessionId: 'sess-1' }))
    // `updateConfiguration` re-derives the full configuration afterward,
    // which calls `listModels()` when no catalog was cached yet.
    process.registerHandler('get_available_models', () => ({
      models: [
        {
          id: 'claude-sonnet-4',
          provider: 'anthropic',
          label: 'Claude Sonnet 4',
        },
      ],
    }))

    await runtime.updateConfiguration({ modelId: 'anthropic/claude-sonnet-4' })
    await runtime.sendTurn({ content: 'hi' })

    const setModelRequests = process.requestsOf('set_model')
    expect(setModelRequests).toHaveLength(1)
    expect(setModelRequests[0]).toMatchObject({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4',
    })
    await runtime.dispose()
  })

  it('restores the current model during catalog warm-up, on the same process as listModels', async () => {
    const runtime = createRuntime()
    await runtime.ensureReady({})
    const process = startedProcesses[0]
    process.registerHandler('get_state', () => ({
      sessionId: 'sess-1',
      model: { id: 'xiaomi/mimo-v2.5', provider: 'openrouter' },
      thinkingLevel: 'medium',
    }))
    process.registerHandler('get_available_models', () => ({
      models: [
        { id: 'xiaomi/mimo-v2.5', provider: 'openrouter', name: 'MiMo' },
      ],
    }))

    await runtime.listModels()
    const configuration = await runtime.getConfiguration()

    expect(configuration.modelId).toBe('openrouter/xiaomi/mimo-v2.5')
    // One get_state piggybacked on the warm-up query — getConfiguration must
    // not have needed a second restoration round-trip.
    expect(process.requestsOf('get_state')).toHaveLength(1)
    await runtime.dispose()
  })

  it('keeps modelId null (no catalog fallback) and retries restoration when get_state has no model yet', async () => {
    const runtime = createRuntime()
    await runtime.ensureReady({})
    const process = startedProcesses[0]
    // pi not configured yet: get_state reports no current model.
    process.registerHandler('get_state', () => ({ sessionId: 'sess-1' }))
    const catalog = [
      {
        id: 'openrouter/ai21/jamba-large',
        label: 'AI21: Jamba Large',
        reasoningEfforts: [],
      },
      {
        id: 'openrouter/xiaomi/mimo-v2.5',
        label: 'Xiaomi: MiMo-V2.5',
        reasoningEfforts: [],
      },
    ]

    const first = await runtime.getConfiguration(catalog)
    // Pre-fix this silently selected the catalog head — an arbitrary
    // alphabetical entry — and would have set_model'd to it on the next turn.
    expect(first.modelId).toBeNull()

    process.registerHandler('prompt', () => undefined)
    await runtime.sendTurn({ content: 'hi' })
    expect(process.requestsOf('set_model')).toHaveLength(0)

    // pi got configured in the meantime: the next getConfiguration retries
    // instead of staying latched on the earlier failure.
    process.registerHandler('get_state', () => ({
      sessionId: 'sess-1',
      model: { id: 'xiaomi/mimo-v2.5', provider: 'openrouter' },
      thinkingLevel: 'medium',
    }))
    const second = await runtime.getConfiguration(catalog)
    expect(second.modelId).toBe('openrouter/xiaomi/mimo-v2.5')
    await runtime.dispose()
  })
})

describe('PiCliRuntime — rewriteTurn', () => {
  it('forks the session file before the edited user turn and prompts on the new session', async () => {
    /* eslint-disable import/no-nodejs-modules -- exercises the desktop-only session-file fork against a real temp dir; runs in Jest/Node only */
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    /* eslint-enable import/no-nodejs-modules */
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-rewrite-'))
    const sourceFile = path.join(dir, 'source.jsonl')
    await fs.writeFile(sourceFile, '{}\n')
    const history = [
      { id: 'u1', type: 'user', message: { role: 'user', content: 'first' } },
      {
        id: 'a1',
        type: 'assistant',
        message: { role: 'assistant', content: 'reply A' },
      },
      {
        id: 't1',
        type: 'toolResult',
        message: { toolCallId: 'call-1', result: 'ok' },
      },
      { id: 'u2', type: 'user', message: { role: 'user', content: 'second' } },
      {
        id: 'a2',
        type: 'assistant',
        message: { role: 'assistant', content: 'reply B' },
      },
    ]

    const { PiSubprocess } = (await import('./process')) as unknown as {
      PiSubprocess: { start: jest.Mock }
    }
    PiSubprocess.start = jest.fn(async (options: { args: string[] }) => {
      const child = new FakePiProcess()
      startedProcesses.push(child)
      const sessionArg = options.args.indexOf('--session')
      const sessionTarget =
        sessionArg >= 0 ? options.args[sessionArg + 1] : sourceFile
      child.registerHandler('get_state', () => ({
        sessionId: sessionTarget === sourceFile ? 'sess-1' : 'forked-session',
        sessionFile: sessionTarget,
      }))
      child.registerHandler('get_entries', () => history)
      child.registerHandler('prompt', () => undefined)
      return child
    })

    const runtime = createRuntime()
    const sessionRef = {
      runtimeId: 'pi' as const,
      nativeSessionId: 'sess-1',
      sessionPathHint: sourceFile,
    }
    await runtime.ensureReady({ sessionRef })
    await runtime.sendTurn({ userMessageId: 'yolo-1', content: 'first' })
    await runtime.sendTurn({ userMessageId: 'yolo-2', content: 'second' })

    await runtime.rewriteTurn({
      sessionRef,
      sourceUserMessageId: 'yolo-2',
      userMessageId: 'yolo-2-edit',
      content: 'edited second',
    })

    const forkedArgs = PiSubprocess.start.mock.calls[1]?.[0].args as string[]
    const forkedFile = forkedArgs[forkedArgs.indexOf('--session') + 1]
    expect(forkedFile).not.toBe(sourceFile)
    const forkedLines = (await fs.readFile(forkedFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id?: string; type?: string })
    expect(forkedLines[0]).toMatchObject({
      type: 'session',
      parentSession: sourceFile,
    })
    expect(forkedLines.slice(1).map((entry) => entry.id)).toEqual([
      'u1',
      'a1',
      't1',
    ])
    expect(startedProcesses[1].requestsOf('prompt')[0]).toMatchObject({
      message: 'edited second',
    })

    await runtime.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('PiCliRuntime — compact', () => {
  it('sends the native compact RPC', async () => {
    const runtime = createRuntime()
    await runtime.ensureReady({})
    const process = startedProcesses[0]
    process.registerHandler('compact', () => ({ summary: 'ok' }))

    await runtime.compact()

    expect(process.requestsOf('compact')).toHaveLength(1)
    await runtime.dispose()
  })
})
