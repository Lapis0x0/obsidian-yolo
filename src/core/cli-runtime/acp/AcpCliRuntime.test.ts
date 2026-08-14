/* eslint-disable import/no-nodejs-modules -- exercises the desktop-only ACP transport boundary */
import { PassThrough } from 'node:stream'
/* eslint-enable import/no-nodejs-modules */

import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import type { CliRuntimeEvent } from '../types'

import { AcpCliRuntime } from './AcpCliRuntime'
import type { AcpProcessExitListener, AcpProcessLike } from './process'

// `transport.ts` loads `node:stream` through `loadDesktopNodeModule`, which
// resolves Node builtins via Obsidian's desktop `require` at runtime — Jest's
// sandboxed module VM doesn't expose that global the same way, so route it
// through Jest's own module loader instead, same as other CLI-runtime
// desktop tests (e.g. `desktopLocalMcpServer.test.ts`).
jest.mock('../../../utils/platform/desktopNodeModule', () => ({
  loadDesktopNodeModule: async (specifier: string) =>
    jest.requireActual(specifier) as unknown,
}))

type RpcMessage = {
  id?: string | number
  method?: string
  result?: unknown
  error?: unknown
  params?: Record<string, unknown>
}

/**
 * A fake ACP agent subprocess: real Node streams (so the real
 * `@agentclientprotocol/sdk` transport runs unmodified end to end), with
 * scriptable per-method responses and the ability to push notifications or
 * server-initiated requests (`requestPermission`) at will.
 */
class FakeAcpAgent implements AcpProcessLike {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly requests: RpcMessage[] = []
  private buffer = ''
  private readonly exitListeners = new Set<AcpProcessExitListener>()
  private handlers = new Map<string, (message: RpcMessage) => unknown>()

  constructor() {
    this.stdin.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      let index: number
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line) as RpcMessage
        this.requests.push(message)
        if (message.method) this.dispatch(message)
      }
    })
    this.on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    }))
  }

  on(method: string, handler: (message: RpcMessage) => unknown): void {
    this.handlers.set(method, handler)
  }

  private dispatch(message: RpcMessage): void {
    const handler = this.handlers.get(message.method as string)
    if (!handler) return
    const result = handler(message)
    if (message.id === undefined) return
    if (result instanceof Promise) {
      void result.then((value) => this.respond(message.id!, value))
    } else {
      this.respond(message.id, result)
    }
  }

  respond(id: string | number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result })
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** Sends a server-initiated request (e.g. `requestPermission`) and returns its eventual result. */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = `srv-${method}-${Math.random()}`
    const promise = new Promise((resolve) => {
      this.pendingServerRequests.set(id, resolve)
    })
    this.send({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  private readonly pendingServerRequests = new Map<
    string,
    (value: unknown) => void
  >()

  private send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  getStderrSnapshot(): string {
    return ''
  }

  onExit(listener: AcpProcessExitListener): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  shutdownCalled = false

  async shutdown(): Promise<void> {
    this.shutdownCalled = true
    this.emitExit()
  }

  emitExit(code: number | null = 0): void {
    for (const listener of this.exitListeners) listener(code, null)
  }
}

// Route the fake agent's own outbound "server requests" replies back into it —
// the stdout stream already carries them; this listens on the *client's*
// outbound stdin traffic for the matching response and resolves the waiter.
const wireServerRequestReplies = (agent: FakeAcpAgent): void => {
  agent.stdin.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let message: RpcMessage
      try {
        message = JSON.parse(line) as RpcMessage
      } catch {
        continue
      }
      if (typeof message.id === 'string' && message.id.startsWith('srv-')) {
        const resolve = (
          agent as unknown as {
            pendingServerRequests: Map<string, (value: unknown) => void>
          }
        ).pendingServerRequests.get(message.id)
        resolve?.(message.result)
      }
    }
  })
}

const createRuntime = (agent: FakeAcpAgent) =>
  new AcpCliRuntime('hermes', {
    cwd: '/vault',
    createProcess: async () => agent,
  })

const collectEvents = (runtime: AcpCliRuntime): CliRuntimeEvent[] => {
  const events: CliRuntimeEvent[] = []
  runtime.subscribe((event) => events.push(event))
  return events
}

describe('AcpCliRuntime', () => {
  it('starts a fresh session and streams a completed turn', async () => {
    const agent = new FakeAcpAgent()
    let sessionId = ''
    agent.on('session/new', () => {
      sessionId = 'sess-1'
      return { sessionId }
    })
    agent.on('session/prompt', (message) => {
      const params = message.params as { sessionId: string }
      agent.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello!' },
        },
      })
      return { stopReason: 'end_turn' }
    })

    const runtime = createRuntime(agent)
    const events = collectEvents(runtime)
    await runtime.ensureReady({})
    await runtime.sendTurn({ content: 'hi' })

    expect(sessionId).toBe('sess-1')
    expect(events).toContainEqual({
      type: 'session_bound',
      ref: { runtimeId: 'hermes', nativeSessionId: 'sess-1' },
    })
    expect(events).toContainEqual({ type: 'run_state', state: 'running' })
    expect(events).toContainEqual({ type: 'run_state', state: 'completed' })
    expect(
      events.some(
        (event) =>
          event.type === 'message_upsert' &&
          event.message.role === 'assistant' &&
          event.message.content === 'Hello!',
      ),
    ).toBe(true)
    await runtime.dispose()
  })

  it('maps a cancelled stop reason to an aborted run state', async () => {
    const agent = new FakeAcpAgent()
    agent.on('session/new', () => ({ sessionId: 'sess-1' }))
    agent.on('session/prompt', () => ({ stopReason: 'cancelled' }))

    const runtime = createRuntime(agent)
    const events = collectEvents(runtime)
    await runtime.ensureReady({})
    await runtime.sendTurn({ content: 'hi' })

    expect(events).toContainEqual({ type: 'run_state', state: 'aborted' })
    await runtime.dispose()
  })

  it('routes a requestPermission through the approval flow and resolves the selected option', async () => {
    const agent = new FakeAcpAgent()
    wireServerRequestReplies(agent)
    agent.on('session/new', () => ({ sessionId: 'sess-1' }))
    let permissionOutcome: unknown
    agent.on('session/prompt', async (message) => {
      const params = message.params as { sessionId: string }
      permissionOutcome = await agent.request('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'call-1',
          title: 'Run npm test',
          kind: 'execute',
          rawInput: { command: 'npm test' },
        },
        options: [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'deny', name: 'Reject once', kind: 'reject_once' },
        ],
      })
      return { stopReason: 'end_turn' }
    })

    const runtime = createRuntime(agent)
    const events = collectEvents(runtime)
    await runtime.ensureReady({})
    const turnPromise = runtime.sendTurn({ content: 'run the tests' })

    // Let the requestPermission round-trip reach AcpCliRuntime before responding.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(events).toContainEqual({
      type: 'run_state',
      state: 'waiting_for_approval',
    })
    const responded = await runtime.respondApproval({
      requestId: 'call-1',
      decision: 'approve_for_session',
    })
    expect(responded).toBe(true)

    await turnPromise
    expect(permissionOutcome).toEqual({
      outcome: { outcome: 'selected', optionId: 'always' },
    })
    const pendingMessage = events.find(
      (event) =>
        event.type === 'message_upsert' &&
        event.message.id === 'acp-result-call-1',
    )
    expect(pendingMessage).toMatchObject({
      message: {
        toolCalls: [
          { response: { status: ToolCallResponseStatus.PendingApproval } },
        ],
      },
    })
    await runtime.dispose()
  })

  it('resolves pending approvals as cancelled and interrupts the agent on cancel()', async () => {
    const agent = new FakeAcpAgent()
    wireServerRequestReplies(agent)
    agent.on('session/new', () => ({ sessionId: 'sess-1' }))
    let permissionOutcome: unknown
    let cancelReceived = false
    agent.on('session/cancel', () => {
      cancelReceived = true
      return undefined
    })
    agent.on('session/prompt', async (message) => {
      const params = message.params as { sessionId: string }
      permissionOutcome = await agent.request('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'call-1',
          title: 'Delete file',
          kind: 'delete',
        },
        options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
      })
      return { stopReason: 'cancelled' }
    })

    const runtime = createRuntime(agent)
    await runtime.ensureReady({})
    const turnPromise = runtime.sendTurn({ content: 'clean up' })
    await new Promise((resolve) => setTimeout(resolve, 10))

    await runtime.cancel()
    await turnPromise

    expect(permissionOutcome).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(cancelReceived).toBe(true)
    await runtime.dispose()
  })

  it('resolves as aborted, not completed, when the agent races the cancel with an end_turn prompt response', async () => {
    // Models the race in issue #5: `cancel()` resolves the pending approval
    // as cancelled, and the agent — instead of waiting for `session/cancel`
    // to be processed — decides to just skip that tool call and finish the
    // turn normally. `session/cancel`'s own response never corrects a
    // `completed` that already got emitted, so the fix must make `sendTurn`
    // itself resolve to `aborted` once cancellation was requested.
    const agent = new FakeAcpAgent()
    wireServerRequestReplies(agent)
    agent.on('session/new', () => ({ sessionId: 'sess-1' }))
    agent.on('session/cancel', () => undefined)
    agent.on('session/prompt', async (message) => {
      const params = message.params as { sessionId: string }
      await agent.request('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'call-1',
          title: 'Delete file',
          kind: 'delete',
        },
        options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
      })
      // The agent decides to just finish rather than honor the cancel.
      return { stopReason: 'end_turn' }
    })

    const runtime = createRuntime(agent)
    const events = collectEvents(runtime)
    await runtime.ensureReady({})
    const turnPromise = runtime.sendTurn({ content: 'clean up' })
    await new Promise((resolve) => setTimeout(resolve, 10))

    await runtime.cancel()
    await turnPromise

    expect(events).toContainEqual({ type: 'run_state', state: 'aborted' })
    expect(
      events.some(
        (event) => event.type === 'run_state' && event.state === 'completed',
      ),
    ).toBe(false)
    await runtime.dispose()
  })

  it('emits an error run state when the agent process exits unexpectedly', async () => {
    const agent = new FakeAcpAgent()
    agent.on('session/new', () => ({ sessionId: 'sess-1' }))

    const runtime = createRuntime(agent)
    const events = collectEvents(runtime)
    await runtime.ensureReady({})
    agent.emitExit(1)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(
      events.some(
        (event) => event.type === 'run_state' && event.state === 'error',
      ),
    ).toBe(true)
    await runtime.dispose()
  })

  it('does not leak the process when dispose() races the host still connecting it', async () => {
    let releaseSpawn: (() => void) | undefined
    let spawnedAgent: FakeAcpAgent | undefined
    const runtime = new AcpCliRuntime('hermes', {
      cwd: '/vault',
      createProcess: () =>
        new Promise<AcpProcessLike>((resolve) => {
          releaseSpawn = () => {
            spawnedAgent = new FakeAcpAgent()
            resolve(spawnedAgent)
          }
        }),
    })

    const ensureReadyPromise = runtime.ensureReady({})
    // Let `getHost()` progress to the point where it has published `this.host`
    // and started `AcpHost.connect()` — which is now blocked on the pending
    // `createProcess()` promise.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await runtime.dispose()

    // Only now does the process finish spawning — `dispose()` already ran
    // and found nothing to shut down.
    releaseSpawn?.()
    await expect(ensureReadyPromise).rejects.toThrow(/disposed/)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(spawnedAgent?.shutdownCalled).toBe(true)
  })
})
