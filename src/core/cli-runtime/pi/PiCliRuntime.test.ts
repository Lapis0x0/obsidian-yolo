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
})
