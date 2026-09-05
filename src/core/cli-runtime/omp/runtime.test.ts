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
jest.mock('../pi/process')

/** Minimal scriptable `omp --mode rpc` stand-in (see pi's own fake process). */
class FakeOmpProcess implements PiProcessLike {
  private readonly handlers = new Map<string, () => unknown>()
  private readonly pendingByType = new Map<string, string[]>()
  private dataListener: ((chunk: string) => void) | null = null
  private exitListener: PiProcessExitListener | null = null

  registerHandler(type: string, fn: () => unknown): void {
    this.handlers.set(type, fn)
    const queued = this.pendingByType.get(type)
    if (!queued) return
    this.pendingByType.delete(type)
    for (const id of queued) this.respond(type, id, fn())
  }

  write(text: string): void {
    const record = JSON.parse(text) as Record<string, unknown>
    const type = record.type as string
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
