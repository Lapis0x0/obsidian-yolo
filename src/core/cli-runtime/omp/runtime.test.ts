import type { App } from 'obsidian'

import { PiCliRuntime } from '../pi/PiCliRuntime'
import type { PiProcessExitListener, PiProcessLike } from '../pi/process'
import type { CliRuntimeEvent } from '../types'

import { OMP_RUNTIME_DIALECT } from './dialect'

jest.mock('../pi/resolve-command', () => ({
  resolvePiCommand: async () => ({ command: 'omp' }),
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
jest.mock('../pi/process')

/** Minimal scriptable `omp --mode rpc` stand-in (see pi's own fake process). */
class FakeOmpProcess implements PiProcessLike {
  private readonly handlers = new Map<string, () => unknown>()
  private readonly pendingByType = new Map<string, string[]>()
  private dataListener: ((chunk: string) => void) | null = null
  private exitListener: PiProcessExitListener | null = null

  constructor() {
    // omp answers the protocol handshake the `ready` frame invites; the
    // engine holds every other command until this lands.
    this.handlers.set('negotiate_protocol', () => ({ protocolVersion: 2 }))
  }

  registerHandler(type: string, fn: () => unknown): void {
    this.handlers.set(type, fn)
    const queued = this.pendingByType.get(type)
    if (!queued) return
    this.pendingByType.delete(type)
    for (const id of queued) this.respond(type, id, fn())
  }

  private readonly written: string[] = []

  sentTypes(): string[] {
    return this.written
  }

  write(text: string): void {
    const record = JSON.parse(text) as Record<string, unknown>
    const type = record.type as string
    this.written.push(type)
    const id = record.id
    if (typeof id !== 'string') return // fire-and-forget, e.g. `abort`
    const handler = this.handlers.get(type)
    if (!handler) {
      this.pendingByType.set(type, [
        ...(this.pendingByType.get(type) ?? []),
        id,
      ])
      return
    }
    this.respond(type, id, handler())
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
    // Real omp writes this before it processes any command.
    queueMicrotask(() =>
      this.emitLine({
        type: 'ready',
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1_048_576,
        maxReassembledFrameBytes: 67_108_864,
      }),
    )
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
    this.exitListener?.(0, null)
  }

  emitLine(record: unknown): void {
    this.dataListener?.(`${JSON.stringify(record)}\n`)
  }
}

const startedProcesses: FakeOmpProcess[] = []

const createRuntime = (): PiCliRuntime =>
  new PiCliRuntime({
    app: {} as App,
    vaultPath: '/vault',
    dialect: OMP_RUNTIME_DIALECT,
  })

const collectEvents = (runtime: PiCliRuntime): CliRuntimeEvent[] => {
  const events: CliRuntimeEvent[] = []
  runtime.subscribe((event) => events.push(event))
  return events
}

const runStates = (events: CliRuntimeEvent[]): string[] =>
  events.flatMap((event) => (event.type === 'run_state' ? [event.state] : []))

beforeEach(async () => {
  startedProcesses.length = 0
  const { PiSubprocess } = (await import('../pi/process')) as unknown as {
    PiSubprocess: { start: jest.Mock }
  }
  PiSubprocess.start = jest.fn(async () => {
    const process = new FakeOmpProcess()
    startedProcesses.push(process)
    return process
  })
})

/** Boots a runtime with a bound session and an accepted, agent-invoking turn. */
const startTurn = async (
  promptData: unknown = { agentInvoked: true },
): Promise<{
  runtime: PiCliRuntime
  process: FakeOmpProcess
  events: CliRuntimeEvent[]
}> => {
  const runtime = createRuntime()
  const events = collectEvents(runtime)
  await runtime.ensureReady({})
  const process = startedProcesses[0]
  process.registerHandler('prompt', () => promptData)
  process.registerHandler('get_state', () => ({ sessionId: 'sess-1' }))
  await runtime.sendTurn({ content: 'hi' })
  return { runtime, process, events }
}

describe('omp on the pi engine — turn terminality', () => {
  it('binds sessions under the omp runtime id, not pi’s', async () => {
    const { runtime, events } = await startTurn()
    expect(events).toContainEqual({
      type: 'session_bound',
      ref: { runtimeId: 'omp', nativeSessionId: 'sess-1' },
    })
    await runtime.dispose()
  })

  it('completes the turn on agent_end, which omp uses instead of agent_settled', async () => {
    const { runtime, process, events } = await startTurn()
    expect(runStates(events)).toEqual(['running'])

    process.emitLine({ type: 'agent_end' })

    expect(runStates(events)).toEqual(['running', 'completed'])
    await runtime.dispose()
  })

  it('keeps the turn open while agent_end says an async task is still running', async () => {
    const { runtime, process, events } = await startTurn()

    process.emitLine({ type: 'agent_end', isTerminal: false })
    expect(runStates(events)).toEqual(['running'])

    process.emitLine({ type: 'agent_end', isTerminal: true })
    expect(runStates(events)).toEqual(['running', 'completed'])
    await runtime.dispose()
  })

  it('closes a prompt that omp handled locally, with no agent turn to wait for', async () => {
    // A pure slash command: omp answers `agentInvoked: false` and then emits
    // nothing at all, so the turn has to end on the response itself.
    const { runtime, events } = await startTurn({ agentInvoked: false })
    expect(runStates(events)).toEqual(['running', 'completed'])
    await runtime.dispose()
  })

  it('closes a deferred prompt_result that never invoked the agent', async () => {
    const { runtime, process, events } = await startTurn({})
    expect(runStates(events)).toEqual(['running'])

    process.emitLine({ type: 'prompt_result', agentInvoked: false })

    expect(runStates(events)).toEqual(['running', 'completed'])
    await runtime.dispose()
  })

  it('settles a turn exactly once when the response and an event both report it', async () => {
    const { runtime, process, events } = await startTurn({
      agentInvoked: false,
    })

    process.emitLine({ type: 'prompt_result', agentInvoked: false })
    process.emitLine({ type: 'agent_end' })

    expect(runStates(events)).toEqual(['running', 'completed'])
    await runtime.dispose()
  })
})

describe('omp on the pi engine — session transcript', () => {
  it('hydrates from the session file, never asking for pi’s get_entries', async () => {
    /* eslint-disable import/no-nodejs-modules -- exercises the desktop-only session-file read against a real temp dir; runs in Jest/Node only */
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    /* eslint-enable import/no-nodejs-modules */
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-hydrate-'))
    const sessionFile = path.join(dir, 'session.jsonl')
    // Exactly what omp writes: a fixed-width title slot, the v3 header, then
    // `message` entries whose role lives on the nested message.
    await fs.writeFile(
      sessionFile,
      [
        { type: 'title', v: 1, title: '问候', pad: '' },
        { type: 'session', version: 3, id: 's1', cwd: '/vault' },
        {
          type: 'message',
          id: 'u1',
          message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
        },
        {
          type: 'message',
          id: 'a1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '你好！' }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    )

    const runtime = createRuntime()
    const hydration = await runtime.openSession({
      runtimeId: 'omp',
      nativeSessionId: 's1',
      sessionPathHint: sessionFile,
    })

    expect(hydration.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ])
    const sent = startedProcesses.flatMap((process) => process.sentTypes())
    expect(sent).not.toContain('get_entries')
    await fs.rm(dir, { recursive: true, force: true })
  })
})
