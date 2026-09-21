/* eslint-disable import/no-nodejs-modules -- exercises the desktop-only ACP transport boundary, and reads real files for disk settlement */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
/* eslint-enable import/no-nodejs-modules */

import type { InitializeResponse } from '@agentclientprotocol/sdk'

import type { ChatToolMessage } from '../../../types/chat'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { buildFileChangeRowsFromTexts } from '../../tools/file-change-rows'
import type { CliRuntimeEvent } from '../types'

import { AcpCliRuntime } from './AcpCliRuntime'
import type { AcpAgentProfile } from './agent-profile'
import { AcpHost } from './host'
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
    try {
      const result = handler(message)
      if (message.id === undefined) return
      if (result instanceof Promise) {
        result.then(
          (value) => this.respond(message.id!, value),
          (error: unknown) => this.respondError(message.id!, error),
        )
      } else {
        this.respond(message.id, result)
      }
    } catch (error) {
      if (message.id !== undefined) this.respondError(message.id, error)
    }
  }

  respond(id: string | number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result })
  }

  /** Simulates a JSON-RPC error response, e.g. a `session/load` that fails because the session is gone. */
  respondError(id: string | number, error: unknown): void {
    this.send({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    })
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
  emitExitOnShutdown = true

  async shutdown(): Promise<void> {
    this.shutdownCalled = true
    if (this.emitExitOnShutdown) this.emitExit()
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

const createProfile = (
  overrides: Partial<AcpAgentProfile>,
): AcpAgentProfile => ({
  runtimeId: 'hermes',
  displayName: 'Hermes',
  resolveCommand: async () => null,
  ...overrides,
})

const createRuntime = (
  agent: FakeAcpAgent,
  profileOverrides?: Partial<AcpAgentProfile>,
) =>
  new AcpCliRuntime('hermes', {
    cwd: '/vault',
    createProcess: async () => agent,
    ...(profileOverrides ? { profile: createProfile(profileOverrides) } : {}),
  })

/** Grok is the runtime whose capabilities declare `supportsImageAttachments: false`. */
const createImagelessRuntime = (agent: FakeAcpAgent) =>
  new AcpCliRuntime('grok', {
    cwd: '/vault',
    createProcess: async () => agent,
  })

const collectEvents = (runtime: AcpCliRuntime): CliRuntimeEvent[] => {
  const events: CliRuntimeEvent[] = []
  runtime.subscribe((event) => events.push(event))
  return events
}

const createHostFor = (agent: FakeAcpAgent) =>
  new AcpHost({
    runtimeId: 'hermes',
    clientName: 'test',
    resolveProcessOptions: async () => ({
      command: '/bin/agent',
      args: [],
      cwd: '/vault',
    }),
    createProcess: async () => agent,
  })

/**
 * A runtime wired with two distinct hosts, mirroring `hermes/factory.ts`'s
 * `resolveHost` (this session's own profile) vs `sessionRecovery.resolveHost`
 * (the default-profile fallback) — never the same host, so a test can tell
 * which one actually served a given call.
 */
const createRuntimeWithRecovery = (
  primaryAgent: FakeAcpAgent,
  fallbackAgent: FakeAcpAgent,
) => {
  const primaryHost = createHostFor(primaryAgent)
  const fallbackHost = createHostFor(fallbackAgent)
  return new AcpCliRuntime('hermes', {
    cwd: '/vault',
    resolveHost: async () => primaryHost,
    sessionRecovery: { resolveHost: async () => fallbackHost },
  })
}

describe('AcpCliRuntime', () => {
  it('authenticates with the selected advertised method before creating a session', async () => {
    const agent = new FakeAcpAgent()
    const calls: string[] = []
    agent.on('initialize', () => {
      calls.push('initialize')
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [
          { id: 'cached_token', name: 'Cached token' },
          { id: 'grok.com', name: 'Grok.com' },
        ],
      }
    })
    agent.on('authenticate', (message) => {
      calls.push('authenticate')
      expect(message.params).toEqual({ methodId: 'cached_token' })
      return {}
    })
    agent.on('session/new', () => {
      calls.push('session/new')
      return { sessionId: 'sess-authenticated' }
    })
    const host = new AcpHost({
      runtimeId: 'hermes',
      clientName: 'test',
      resolveProcessOptions: async () => ({
        command: '/bin/agent',
        args: [],
        cwd: '/vault',
      }),
      createProcess: async () => agent,
      selectAuthMethod: (init: InitializeResponse) =>
        init.authMethods?.find((method) => method.id === 'cached_token')?.id,
    })
    const runtime = new AcpCliRuntime('hermes', {
      cwd: '/vault',
      resolveHost: async () => host,
    })

    await runtime.ensureReady({})

    expect(calls).toEqual(['initialize', 'authenticate', 'session/new'])
    await runtime.dispose()
  })

  it('rejects an auth method that the agent did not advertise and shuts down the process', async () => {
    const agent = new FakeAcpAgent()
    agent.on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'cached_token', name: 'Cached token' }],
    }))
    const host = new AcpHost({
      runtimeId: 'hermes',
      clientName: 'test',
      resolveProcessOptions: async () => ({
        command: '/bin/agent',
        args: [],
        cwd: '/vault',
      }),
      createProcess: async () => agent,
      selectAuthMethod: () => 'not-advertised',
    })

    await expect(host.ensureReady()).rejects.toThrow(
      'selected authentication method "not-advertised" was not advertised',
    )
    expect(agent.shutdownCalled).toBe(true)
    expect(
      agent.requests.some((request) => request.method === 'authenticate'),
    ).toBe(false)
  })

  it('shuts down the process when authentication fails without creating a session', async () => {
    const agent = new FakeAcpAgent()
    agent.on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'cached_token', name: 'Cached token' }],
    }))
    agent.on('authenticate', () => {
      throw new Error('cached login expired')
    })
    agent.on('session/new', () => ({ sessionId: 'must-not-run' }))
    const host = new AcpHost({
      runtimeId: 'hermes',
      clientName: 'test',
      resolveProcessOptions: async () => ({
        command: '/bin/agent',
        args: [],
        cwd: '/vault',
      }),
      createProcess: async () => agent,
      selectAuthMethod: () => 'cached_token',
    })
    const runtime = new AcpCliRuntime('hermes', {
      cwd: '/vault',
      resolveHost: async () => host,
    })

    await expect(runtime.ensureReady({})).rejects.toThrow(
      'cached login expired',
    )
    expect(agent.shutdownCalled).toBe(true)
    expect(
      agent.requests.some((request) => request.method === 'session/new'),
    ).toBe(false)
  })

  it('ignores a delayed exit from an auth-failed process after a retry connects', async () => {
    const failedAgent = new FakeAcpAgent()
    failedAgent.emitExitOnShutdown = false
    failedAgent.on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'cached_token', name: 'Cached token' }],
    }))
    failedAgent.on('authenticate', () => {
      throw new Error('cached login expired')
    })

    const connectedAgent = new FakeAcpAgent()
    connectedAgent.on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'cached_token', name: 'Cached token' }],
    }))
    connectedAgent.on('authenticate', () => ({}))

    let spawnCount = 0
    const host = new AcpHost({
      runtimeId: 'hermes',
      clientName: 'test',
      resolveProcessOptions: async () => ({
        command: '/bin/agent',
        args: [],
        cwd: '/vault',
      }),
      createProcess: async () => {
        spawnCount += 1
        return spawnCount === 1 ? failedAgent : connectedAgent
      },
      selectAuthMethod: () => 'cached_token',
    })

    await expect(host.ensureReady()).rejects.toThrow('cached login expired')
    await expect(host.ensureReady()).resolves.toBeUndefined()

    failedAgent.emitExit()
    await expect(host.ensureReady()).resolves.toBeUndefined()

    expect(spawnCount).toBe(2)
    await host.dispose()
  })

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

  it('rejects image input for a runtime that declares no image attachments', async () => {
    const agent = new FakeAcpAgent()
    let promptCalled = false
    agent.on('session/new', () => ({ sessionId: 'sess-no-images' }))
    agent.on('session/prompt', () => {
      promptCalled = true
      return { stopReason: 'end_turn' }
    })

    const runtime = createImagelessRuntime(agent)
    const events = collectEvents(runtime)
    await runtime.ensureReady({})

    await expect(
      runtime.sendTurn({
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,QUJD' },
          },
        ],
      }),
    ).rejects.toThrow('does not support image input')
    expect(promptCalled).toBe(false)
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'run_state', state: 'running' }),
    )
    await runtime.dispose()
  })

  it('rejects an image carried as a URL, which maps to a resource link rather than an image block', async () => {
    const agent = new FakeAcpAgent()
    let promptCalled = false
    agent.on('session/new', () => ({ sessionId: 'sess-linked-image' }))
    agent.on('session/prompt', () => {
      promptCalled = true
      return { stopReason: 'end_turn' }
    })

    const runtime = createImagelessRuntime(agent)
    await runtime.ensureReady({})

    await expect(
      runtime.sendTurn({
        content: [
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/diagram.png' },
          },
        ],
      }),
    ).rejects.toThrow('does not support image input')
    expect(promptCalled).toBe(false)
    await runtime.dispose()
  })

  it('forwards image blocks for an image-capable runtime even when the agent advertises no image capability', async () => {
    const agent = new FakeAcpAgent()
    let prompt: unknown
    agent.on('session/new', () => ({ sessionId: 'sess-silent-capability' }))
    agent.on('session/prompt', (message) => {
      prompt = message.params?.prompt
      return { stopReason: 'end_turn' }
    })

    const runtime = createRuntime(agent)
    await runtime.ensureReady({})
    await runtime.sendTurn({
      content: [
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,QUJD' },
        },
      ],
    })

    expect(prompt).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'QUJD' },
    ])
    await runtime.dispose()
  })

  it('forwards image blocks when the ACP agent explicitly supports them', async () => {
    const agent = new FakeAcpAgent()
    let prompt: unknown
    agent.on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
      },
    }))
    agent.on('session/new', () => ({ sessionId: 'sess-images' }))
    agent.on('session/prompt', (message) => {
      prompt = message.params?.prompt
      return { stopReason: 'end_turn' }
    })

    const runtime = createRuntime(agent)
    await runtime.ensureReady({})
    await runtime.sendTurn({
      content: [
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,QUJD' },
        },
      ],
    })

    expect(prompt).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'QUJD' },
    ])
    await runtime.dispose()
  })

  it('surfaces a usage_update as context usage without touching the transcript', async () => {
    const agent = new FakeAcpAgent()
    agent.on('session/new', () => ({ sessionId: 'sess-1' }))
    agent.on('session/prompt', (message) => {
      const params = message.params as { sessionId: string }
      agent.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello!' },
        },
      })
      // Hermes reports context pressure once the turn settles.
      agent.notify('session/update', {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'usage_update', used: 12_345, size: 200_000 },
      })
      return { stopReason: 'end_turn' }
    })

    const runtime = createRuntime(agent)
    const events = collectEvents(runtime)
    await runtime.ensureReady({})
    await runtime.sendTurn({ content: 'hi' })

    expect(events).toContainEqual({
      type: 'context_usage',
      usage: { promptTokens: 12_345, maxContextTokens: 200_000 },
    })
    expect(
      events.filter(
        (event) =>
          event.type === 'message_upsert' && event.message.role === 'assistant',
      ),
    ).toHaveLength(1)
    await runtime.dispose()
  })

  it('reports turn metrics before the terminal run state so the footer keeps them', async () => {
    const agent = new FakeAcpAgent()
    agent.on('session/new', () => ({ sessionId: 'sess-1' }))
    agent.on('session/prompt', () => ({
      stopReason: 'end_turn',
      usage: {
        inputTokens: 6_800,
        outputTokens: 572,
        totalTokens: 7_372,
        cachedReadTokens: 5_800,
      },
    }))

    const runtime = createRuntime(agent)
    const events = collectEvents(runtime)
    await runtime.ensureReady({})
    await runtime.sendTurn({ content: 'hi' })

    const metricsIndex = events.findIndex(
      (event) => event.type === 'turn_metrics',
    )
    const completedIndex = events.findIndex(
      (event) => event.type === 'run_state' && event.state === 'completed',
    )
    // The controller closes the turn's metrics window on the terminal run
    // state, so metrics emitted after it would be dropped.
    expect(metricsIndex).toBeGreaterThanOrEqual(0)
    expect(metricsIndex).toBeLessThan(completedIndex)
    const metrics = events[metricsIndex]
    expect(metrics).toMatchObject({
      type: 'turn_metrics',
      usage: {
        prompt_tokens: 6_800,
        completion_tokens: 572,
        total_tokens: 7_372,
        cache_read_input_tokens: 5_800,
      },
    })
    expect(
      metrics.type === 'turn_metrics' ? metrics.durationMs : undefined,
    ).toEqual(expect.any(Number))
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
    const responded = await runtime.respondApproval({
      requestId: 'call-1',
      decision: 'approve_for_session',
    })
    expect(responded).toEqual({ status: ToolCallResponseStatus.Running })

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

  describe('settling a completed file change against disk', () => {
    let vault: string

    beforeEach(async () => {
      vault = await mkdtemp(join(tmpdir(), 'yolo-acp-disk-'))
    })

    afterEach(async () => {
      await rm(vault, { recursive: true, force: true })
    })

    const runEditTurn = async (diff: {
      path: string
      oldText: string
      newText: string
    }) => {
      const agent = new FakeAcpAgent()
      agent.on('session/new', () => ({ sessionId: 'sess-1' }))
      agent.on('session/prompt', (message) => {
        const { sessionId } = message.params as { sessionId: string }
        agent.notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'edit-1',
            title: 'Edit a.md',
            kind: 'edit',
            status: 'pending',
            content: [{ type: 'diff', ...diff }],
          },
        })
        agent.notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'edit-1',
            status: 'completed',
            content: [
              { type: 'content', content: { type: 'text', text: 'Done.' } },
            ],
          },
        })
        return { stopReason: 'end_turn' }
      })
      const runtime = new AcpCliRuntime('codebuddy', {
        cwd: vault,
        createProcess: async () => agent,
      })
      const events = collectEvents(runtime)
      await runtime.ensureReady({})
      await runtime.sendTurn({ content: 'edit a.md' })
      await runtime.dispose()
      const cards = events.flatMap((event) =>
        event.type === 'message_upsert' &&
        event.message.id === 'acp-result-edit-1'
          ? [event.message as ChatToolMessage]
          : [],
      )
      return cards.at(-1)?.toolCalls[0].request.metadata?.fileChangeRows
    }

    it('redraws a span diff from the whole file, with its real line numbers, before the turn ends', async () => {
      await writeFile(join(vault, 'a.md'), '1\n2\nnew 3\n4\n')
      const rows = await runEditTurn({
        path: join(vault, 'a.md'),
        oldText: 'old 3\n',
        newText: 'new 3\n',
      })
      expect(rows).toEqual([
        buildFileChangeRowsFromTexts(
          'a.md',
          '1\n2\nold 3\n4\n',
          '1\n2\nnew 3\n4\n',
        ),
      ])
    })

    it('leaves the rows unnumbered when the disk does not bear the diff out', async () => {
      await writeFile(join(vault, 'a.md'), 'changed again\n')
      const rows = await runEditTurn({
        path: 'a.md',
        oldText: 'old\n',
        newText: 'new\n',
      })
      expect(rows?.[0].rows).toEqual([
        { type: 'line', change: 'removed', text: 'old' },
        { type: 'line', change: 'added', text: 'new' },
      ])
    })
  })

  describe('settling cards at the end of a turn', () => {
    // Hermes' shape: the approval request carries a toolCallId of its own, so
    // nothing the agent sends afterwards ever addresses the approval card.
    const startApprovedTurn = (
      stopReason: 'end_turn' | 'cancelled',
    ): FakeAcpAgent => {
      const agent = new FakeAcpAgent()
      wireServerRequestReplies(agent)
      agent.on('session/new', () => ({ sessionId: 'sess-1' }))
      agent.on('session/prompt', async (message) => {
        const params = message.params as { sessionId: string }
        await agent.request('session/request_permission', {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: 'edit-approval-1',
            title: 'Approve edit: a.md',
            kind: 'edit',
          },
          options: [
            { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
          ],
        })
        return { stopReason }
      })
      return agent
    }

    const lastCardStatus = (events: CliRuntimeEvent[], messageId: string) => {
      const upserts = events.filter(
        (event) =>
          event.type === 'message_upsert' && event.message.id === messageId,
      )
      const last = upserts.at(-1)
      return last?.type === 'message_upsert' && last.message.role === 'tool'
        ? last.message.toolCalls[0].response.status
        : undefined
    }

    it('settles an approved card nothing reported back on to success before the turn completes', async () => {
      const agent = startApprovedTurn('end_turn')
      const runtime = createRuntime(agent)
      const events = collectEvents(runtime)
      await runtime.ensureReady({})
      const turn = runtime.sendTurn({ content: 'edit a.md' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await expect(
        runtime.respondApproval({
          requestId: 'edit-approval-1',
          decision: 'approve_once',
        }),
      ).resolves.toEqual({ status: ToolCallResponseStatus.Running })
      await turn

      expect(lastCardStatus(events, 'acp-result-edit-approval-1')).toBe(
        ToolCallResponseStatus.Success,
      )
      const settledIndex = events.findLastIndex(
        (event) =>
          event.type === 'message_upsert' &&
          event.message.id === 'acp-result-edit-approval-1',
      )
      const completedIndex = events.findIndex(
        (event) => event.type === 'run_state' && event.state === 'completed',
      )
      expect(settledIndex).toBeLessThan(completedIndex)
      await runtime.dispose()
    })

    it('settles it to aborted when the turn was cancelled', async () => {
      const agent = startApprovedTurn('cancelled')
      const runtime = createRuntime(agent)
      const events = collectEvents(runtime)
      await runtime.ensureReady({})
      const turn = runtime.sendTurn({ content: 'edit a.md' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await runtime.respondApproval({
        requestId: 'edit-approval-1',
        decision: 'approve_once',
      })
      await turn

      expect(lastCardStatus(events, 'acp-result-edit-approval-1')).toBe(
        ToolCallResponseStatus.Aborted,
      )
      await runtime.dispose()
    })

    it('reports a declined request as rejected and leaves it alone', async () => {
      const agent = startApprovedTurn('end_turn')
      const runtime = createRuntime(agent)
      const events = collectEvents(runtime)
      await runtime.ensureReady({})
      const turn = runtime.sendTurn({ content: 'edit a.md' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await expect(
        runtime.respondApproval({
          requestId: 'edit-approval-1',
          decision: 'reject',
        }),
      ).resolves.toEqual({ status: ToolCallResponseStatus.Rejected })
      await turn

      // The only upsert is the pending card: the host publishes `Rejected`.
      expect(lastCardStatus(events, 'acp-result-edit-approval-1')).toBe(
        ToolCallResponseStatus.PendingApproval,
      )
      await runtime.dispose()
    })
  })

  /**
   * Session modes are how an ACP agent exposes its own approval policy, and
   * they are the only lever that stops it from asking in the first place.
   * The mode ids are agent-defined, so the mapping comes from the profile.
   */
  const MODES = {
    currentModeId: 'tame',
    availableModes: [{ id: 'tame' }, { id: 'wild' }],
  }

  const yoloAwareProfile: Partial<AcpAgentProfile> = {
    resolveSessionModeId: ({ yoloEnabled }) => (yoloEnabled ? 'wild' : 'tame'),
  }

  const collectModeRequests = (agent: FakeAcpAgent): string[] => {
    const applied: string[] = []
    agent.on('session/set_mode', (message) => {
      applied.push((message.params as { modeId: string }).modeId)
      return {}
    })
    return applied
  }

  it('applies the profile-mapped session mode to the agent once a session binds', async () => {
    const agent = new FakeAcpAgent()
    agent.on('session/new', () => ({ sessionId: 'sess-1', modes: MODES }))
    const applied = collectModeRequests(agent)

    const runtime = createRuntime(agent, yoloAwareProfile)
    // Deliberately before ensureReady: the toggle can be flipped while no
    // session is bound yet, and the profile still has to reach the agent.
    await runtime.updatePermissionProfile({ mode: 'agent', yoloEnabled: true })
    await runtime.ensureReady({})

    expect(applied).toEqual(['wild'])
    await runtime.dispose()
  })

  it('re-applies the session mode when another session binds', async () => {
    const agent = new FakeAcpAgent()
    agent.on('session/new', () => ({ sessionId: 'sess-1', modes: MODES }))
    // A freshly loaded session carries its own mode — the one the agent
    // actually has it on, not whatever the previously bound session was set
    // to. Skipping the re-apply here is what would silently strand the new
    // session on the agent's default policy.
    agent.on('session/load', () => ({ modes: MODES }))
    const applied = collectModeRequests(agent)

    const runtime = createRuntime(agent, yoloAwareProfile)
    await runtime.updatePermissionProfile({ mode: 'agent', yoloEnabled: true })
    await runtime.ensureReady({})
    await runtime.ensureReady({
      sessionRef: { runtimeId: 'hermes', nativeSessionId: 'sess-2' },
    })

    expect(applied).toEqual(['wild', 'wild'])
    await runtime.dispose()
  })

  it('leaves the agent alone when it never advertised the mapped mode', async () => {
    const agent = new FakeAcpAgent()
    agent.on('session/new', () => ({
      sessionId: 'sess-1',
      modes: { currentModeId: 'tame', availableModes: [{ id: 'tame' }] },
    }))
    const applied = collectModeRequests(agent)

    const runtime = createRuntime(agent, yoloAwareProfile)
    await runtime.updatePermissionProfile({ mode: 'agent', yoloEnabled: true })
    await runtime.ensureReady({})

    expect(applied).toEqual([])
    await runtime.dispose()
  })

  it('answers permission requests itself while YOLO is on, raising no card', async () => {
    const agent = new FakeAcpAgent()
    wireServerRequestReplies(agent)
    agent.on('session/new', () => ({ sessionId: 'sess-1', modes: MODES }))
    collectModeRequests(agent)
    let permissionOutcome: unknown
    agent.on('session/prompt', async (message) => {
      const params = message.params as { sessionId: string }
      permissionOutcome = await agent.request('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'call-1',
          title: 'Run rm -rf',
          kind: 'execute',
        },
        // Hermes's real list: a session-scoped and a permanent option, both
        // reported under ACP's single `allow_always` kind, session first.
        options: [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          {
            optionId: 'session',
            name: 'Allow for session',
            kind: 'allow_always',
          },
          {
            optionId: 'permanent',
            name: 'Allow always',
            kind: 'allow_always',
          },
          { optionId: 'deny', name: 'Reject once', kind: 'reject_once' },
        ],
      })
      return { stopReason: 'end_turn' }
    })

    const runtime = createRuntime(agent, yoloAwareProfile)
    const events = collectEvents(runtime)
    await runtime.updatePermissionProfile({ mode: 'agent', yoloEnabled: true })
    await runtime.ensureReady({})
    await runtime.sendTurn({ content: 'clean up' })

    // Session-scoped, not permanent: YOLO authorizes this conversation, so
    // it must not leave a standing allow-list entry in the agent.
    expect(permissionOutcome).toEqual({
      outcome: { outcome: 'selected', optionId: 'session' },
    })
    // Nothing was ever surfaced for the user to act on.
    expect(
      events.some(
        (event) =>
          event.type === 'message_upsert' &&
          event.message.id === 'acp-result-call-1',
      ),
    ).toBe(false)
    await runtime.dispose()
  })

  it('still raises an approval card once YOLO is turned back off', async () => {
    const agent = new FakeAcpAgent()
    wireServerRequestReplies(agent)
    agent.on('session/new', () => ({ sessionId: 'sess-1', modes: MODES }))
    collectModeRequests(agent)
    agent.on('session/prompt', async (message) => {
      const params = message.params as { sessionId: string }
      await agent.request('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'call-1',
          title: 'Run rm -rf',
          kind: 'execute',
        },
        options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
      })
      return { stopReason: 'end_turn' }
    })

    const runtime = createRuntime(agent, yoloAwareProfile)
    const events = collectEvents(runtime)
    await runtime.updatePermissionProfile({ mode: 'agent', yoloEnabled: true })
    await runtime.ensureReady({})
    await runtime.updatePermissionProfile({ mode: 'agent', yoloEnabled: false })
    const turnPromise = runtime.sendTurn({ content: 'clean up' })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(
      events.some(
        (event) =>
          event.type === 'message_upsert' &&
          event.message.id === 'acp-result-call-1',
      ),
    ).toBe(true)
    await runtime.respondApproval({
      requestId: 'call-1',
      decision: 'approve_once',
    })
    await turnPromise
    await runtime.dispose()
  })

  it('answers an approval with the state its card becomes, not by republishing it', async () => {
    const agent = new FakeAcpAgent()
    wireServerRequestReplies(agent)
    agent.on('session/new', () => ({ sessionId: 'sess-1' }))
    agent.on('session/prompt', async (message) => {
      const params = message.params as { sessionId: string }
      await agent.request('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'call-1',
          title: 'Run npm test',
          kind: 'execute',
        },
        options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
      })
      return { stopReason: 'end_turn' }
    })

    const runtime = createRuntime(agent)
    const events = collectEvents(runtime)
    await runtime.ensureReady({})
    const turnPromise = runtime.sendTurn({ content: 'run the tests' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The waiting run state is derived from the card, never announced.
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'run_state',
        state: 'waiting_for_approval',
      }),
    )
    const eventsBeforeAnswer = events.length

    // The settled state is the return value — the host publishes it (see
    // `CliRuntime.respondApproval`).
    await expect(
      runtime.respondApproval({
        requestId: 'call-1',
        decision: 'approve_once',
      }),
    ).resolves.toEqual({ status: ToolCallResponseStatus.Running })
    expect(events).toHaveLength(eventsBeforeAnswer)

    await turnPromise
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

  it('captures the model list from session/new and applies a pick via session/set_model', async () => {
    const agent = new FakeAcpAgent()
    agent.on('session/new', () => ({
      sessionId: 'sess-1',
      models: {
        availableModels: [
          {
            modelId: 'openrouter:xiaomi/mimo-v2.5',
            name: 'OpenRouter · xiaomi/mimo-v2.5',
            description: 'Provider: OpenRouter • current',
          },
          {
            modelId: 'openrouter:anthropic/claude-sonnet-5',
            name: 'OpenRouter · anthropic/claude-sonnet-5',
          },
        ],
        currentModelId: 'openrouter:xiaomi/mimo-v2.5',
      },
    }))
    agent.on('session/set_model', () => ({}))

    const runtime = createRuntime(agent)
    await runtime.ensureReady({})

    const configuration = await runtime.getConfiguration()
    expect(configuration.models.map((model) => model.id)).toEqual([
      'openrouter:xiaomi/mimo-v2.5',
      'openrouter:anthropic/claude-sonnet-5',
    ])
    expect(configuration.modelId).toBe('openrouter:xiaomi/mimo-v2.5')

    const updated = await runtime.updateConfiguration({
      modelId: 'openrouter:anthropic/claude-sonnet-5',
    })
    const setModelRequest = agent.requests.find(
      (message) => message.method === 'session/set_model',
    )
    expect(setModelRequest?.params).toEqual({
      sessionId: 'sess-1',
      modelId: 'openrouter:anthropic/claude-sonnet-5',
    })
    expect(updated.modelId).toBe('openrouter:anthropic/claude-sonnet-5')
    await runtime.dispose()
  })

  it('falls back to cached models and skips set_model when the agent reports none', async () => {
    const agent = new FakeAcpAgent()
    agent.on('session/new', () => ({ sessionId: 'sess-1' }))

    const runtime = createRuntime(agent)
    await runtime.ensureReady({})

    const cached = [
      { id: 'cached-model', label: 'Cached model', reasoningEfforts: [] },
    ]
    const configuration = await runtime.getConfiguration(cached)
    expect(configuration.models).toEqual(cached)
    expect(configuration.modelId).toBeNull()

    // `null` means "keep the agent's own selection" — no protocol call.
    await runtime.updateConfiguration({ modelId: null })
    expect(
      agent.requests.some((message) => message.method === 'session/set_model'),
    ).toBe(false)
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

  describe('compact()', () => {
    it('sends the agent compact command as a prompt, suppresses its user echo, and emits a compaction boundary without touching run_state', async () => {
      const agent = new FakeAcpAgent()
      agent.on('session/new', () => ({ sessionId: 'sess-1' }))
      const promptedTexts: string[] = []
      agent.on('session/prompt', (message) => {
        const params = message.params as {
          sessionId: string
          prompt: { type: string; text?: string }[]
        }
        promptedTexts.push(...params.prompt.map((block) => block.text ?? ''))
        // Hermes echoes the prompt back as a user_message_chunk, then
        // replies with a plain-text summary — no structured compaction
        // event exists on the wire.
        agent.notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: '/compress' },
          },
        })
        agent.notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Context compressed: 42 -> 8 messages',
            },
          },
        })
        return { stopReason: 'end_turn' }
      })

      const runtime = createRuntime(agent, { compactCommand: '/compress' })
      const events = collectEvents(runtime)
      await runtime.ensureReady({})

      await runtime.compact()

      expect(promptedTexts).toEqual(['/compress'])
      // No synthetic user turn ever renders for the compact prompt.
      expect(
        events.some(
          (event) =>
            event.type === 'message_upsert' && event.message.role === 'user',
        ),
      ).toBe(false)
      // The agent's reply still renders normally, so a failure reason stays visible.
      expect(
        events.some(
          (event) =>
            event.type === 'message_upsert' &&
            event.message.role === 'assistant' &&
            event.message.content === 'Context compressed: 42 -> 8 messages',
        ),
      ).toBe(true)
      expect(events).toContainEqual({
        type: 'compaction_boundary',
        boundary: expect.objectContaining({ trigger: 'manual' }) as unknown,
      })
      // compact() reuses the ordinary prompt round trip but never emits
      // run_state — the conversation controller already tracks compaction
      // via `isCompacting`, and run_state stays reserved for real turns.
      expect(events.some((event) => event.type === 'run_state')).toBe(false)
      await runtime.dispose()
    })

    it('throws when the connected agent has no configured compact command', async () => {
      const agent = new FakeAcpAgent()
      agent.on('session/new', () => ({ sessionId: 'sess-1' }))

      const runtime = createRuntime(agent)
      await runtime.ensureReady({})

      await expect(runtime.compact()).rejects.toThrow(
        /does not support compaction/,
      )
      await runtime.dispose()
    })
  })

  describe('sessionRecovery', () => {
    it('openSession() falls back to a fresh session on the recovery host when loadSession fails, and flags it', async () => {
      const primaryAgent = new FakeAcpAgent()
      primaryAgent.on('session/load', () => {
        throw new Error('session not found')
      })
      const fallbackAgent = new FakeAcpAgent()
      fallbackAgent.on('session/new', () => ({ sessionId: 'fallback-sess' }))

      const runtime = createRuntimeWithRecovery(primaryAgent, fallbackAgent)
      const requestedRef = {
        runtimeId: 'hermes' as const,
        nativeSessionId: 'gone-sess',
      }
      const hydration = await runtime.openSession(requestedRef)

      expect(hydration.ref).toEqual({
        runtimeId: 'hermes',
        nativeSessionId: 'fallback-sess',
      })
      expect(hydration.messages).toEqual([])
      expect(hydration.sessionFallback).toEqual({ requestedRef })
      await runtime.dispose()
    })

    it('ensureReady() falls back live, binding the fresh session and flagging the bind as a fallback', async () => {
      const primaryAgent = new FakeAcpAgent()
      primaryAgent.on('session/load', () => {
        throw new Error('session not found')
      })
      const fallbackAgent = new FakeAcpAgent()
      fallbackAgent.on('session/new', () => ({ sessionId: 'fallback-sess' }))
      let promptedOnFallback = false
      fallbackAgent.on('session/prompt', () => {
        promptedOnFallback = true
        return { stopReason: 'end_turn' }
      })
      let promptedOnPrimary = false
      primaryAgent.on('session/prompt', () => {
        promptedOnPrimary = true
        return { stopReason: 'end_turn' }
      })

      const runtime = createRuntimeWithRecovery(primaryAgent, fallbackAgent)
      const events = collectEvents(runtime)
      const requestedRef = {
        runtimeId: 'hermes' as const,
        nativeSessionId: 'gone-sess',
      }
      await runtime.ensureReady({ sessionRef: requestedRef })

      expect(events).toContainEqual({
        type: 'session_bound',
        ref: { runtimeId: 'hermes', nativeSessionId: 'fallback-sess' },
        fallbackFrom: requestedRef,
      })

      // Every subsequent call (sendTurn included) must go through the host
      // the runtime actually switched to, not the original, unreachable one.
      await runtime.sendTurn({ content: 'hi' })
      expect(promptedOnFallback).toBe(true)
      expect(promptedOnPrimary).toBe(false)
      await runtime.dispose()
    })

    it('still throws when loadSession fails and no sessionRecovery is configured', async () => {
      const agent = new FakeAcpAgent()
      agent.on('session/load', () => {
        throw new Error('session not found')
      })

      const runtime = createRuntime(agent)
      const requestedRef = {
        runtimeId: 'hermes' as const,
        nativeSessionId: 'gone-sess',
      }
      await expect(runtime.openSession(requestedRef)).rejects.toThrow(
        /session not found/,
      )
      await runtime.dispose()
    })

    // Regression coverage for the main real-world trigger: a deleted Hermes
    // profile makes `hermes -p <deleted> acp` exit *before* the ACP
    // handshake completes, so the failure surfaces from resolving/readying
    // the primary host itself — never from `session/load`, which is never
    // reached. The two tests above (which fail an already-connected fake
    // host's `session/load`) do not exercise this at all.
    it('openSession() falls back to recovery when the primary host fails to resolve, not just when loadSession fails', async () => {
      const fallbackAgent = new FakeAcpAgent()
      fallbackAgent.on('session/new', () => ({ sessionId: 'fallback-sess' }))
      const fallbackHost = createHostFor(fallbackAgent)

      const runtime = new AcpCliRuntime('hermes', {
        cwd: '/vault',
        resolveHost: async () => {
          throw new Error("Profile 'deleted-profile' does not exist.")
        },
        sessionRecovery: { resolveHost: async () => fallbackHost },
      })
      const requestedRef = {
        runtimeId: 'hermes' as const,
        nativeSessionId: 'gone-sess',
        profileId: 'deleted-profile',
      }
      const hydration = await runtime.openSession(requestedRef)

      expect(hydration.ref).toEqual({
        runtimeId: 'hermes',
        nativeSessionId: 'fallback-sess',
      })
      expect(hydration.sessionFallback).toEqual({ requestedRef })
      await runtime.dispose()
    })

    it('ensureReady() falls back live when the primary host fails to initialize (agent exits before the ACP handshake completes)', async () => {
      const primaryAgent = new FakeAcpAgent()
      // Overrides the constructor's default `initialize` handler so the
      // handshake itself fails, mirroring a deleted profile's process dying
      // before it ever gets there — the session is never even loaded.
      primaryAgent.on('initialize', () => {
        throw new Error("Profile 'deleted-profile' does not exist.")
      })
      const fallbackAgent = new FakeAcpAgent()
      fallbackAgent.on('session/new', () => ({ sessionId: 'fallback-sess' }))
      let promptedOnFallback = false
      fallbackAgent.on('session/prompt', () => {
        promptedOnFallback = true
        return { stopReason: 'end_turn' }
      })

      const runtime = createRuntimeWithRecovery(primaryAgent, fallbackAgent)
      const events = collectEvents(runtime)
      const requestedRef = {
        runtimeId: 'hermes' as const,
        nativeSessionId: 'gone-sess',
        profileId: 'deleted-profile',
      }
      await runtime.ensureReady({ sessionRef: requestedRef })

      expect(events).toContainEqual({
        type: 'session_bound',
        ref: { runtimeId: 'hermes', nativeSessionId: 'fallback-sess' },
        fallbackFrom: requestedRef,
      })
      await runtime.sendTurn({ content: 'hi' })
      expect(promptedOnFallback).toBe(true)
      await runtime.dispose()
    })

    it('ensureReady() still throws when starting a brand-new session (no sessionRef) and the primary host fails, even with sessionRecovery configured', async () => {
      // A new session has nothing to recover *into* — `sessionRecovery`
      // exists to resume a specific stored session under a different host,
      // not to silently redirect a fresh conversation the user never asked
      // to move.
      const runtime = new AcpCliRuntime('hermes', {
        cwd: '/vault',
        resolveHost: async () => {
          throw new Error('primary host unavailable')
        },
        sessionRecovery: {
          resolveHost: async () => {
            throw new Error('fallback should never be consulted')
          },
        },
      })

      await expect(runtime.ensureReady({})).rejects.toThrow(
        /primary host unavailable/,
      )
      await runtime.dispose()
    })

    it('propagates the error, rather than swallowing it, when recovery itself fails', async () => {
      const runtime = new AcpCliRuntime('hermes', {
        cwd: '/vault',
        resolveHost: async () => {
          throw new Error("Profile 'deleted-profile' does not exist.")
        },
        sessionRecovery: {
          resolveHost: async () => {
            throw new Error('default profile is also unreachable')
          },
        },
      })
      const requestedRef = {
        runtimeId: 'hermes' as const,
        nativeSessionId: 'gone-sess',
        profileId: 'deleted-profile',
      }

      await expect(runtime.openSession(requestedRef)).rejects.toThrow(
        /default profile is also unreachable/,
      )
      await runtime.dispose()
    })

    it('ensureReady() propagates the error, rather than swallowing it, when recovery itself fails', async () => {
      const runtime = new AcpCliRuntime('hermes', {
        cwd: '/vault',
        resolveHost: async () => {
          throw new Error("Profile 'deleted-profile' does not exist.")
        },
        sessionRecovery: {
          resolveHost: async () => {
            throw new Error('default profile is also unreachable')
          },
        },
      })
      const requestedRef = {
        runtimeId: 'hermes' as const,
        nativeSessionId: 'gone-sess',
        profileId: 'deleted-profile',
      }

      await expect(
        runtime.ensureReady({ sessionRef: requestedRef }),
      ).rejects.toThrow(/default profile is also unreachable/)
      await runtime.dispose()
    })

    // Regression coverage: `recoverSession`/`bindRecoveredSession` used to
    // call `attachHost()` (which swaps `this.host`, detaches the original
    // host's fatal listener, and attaches one on the candidate) *before*
    // starting a session on the candidate host. A candidate that resolves
    // fine but whose `session/new` itself fails then left the runtime
    // permanently pointed at that broken host: a retry would try to load
    // the original profile's session on the *wrong* (default) host instead
    // of re-resolving the original, and the original host's own crashes
    // would stop surfacing. These two tests pin the fixed sequencing: the
    // candidate must fully succeed before anything about `this.host` is
    // touched.
    it('openSession(): a recovery candidate whose newSession() fails leaves the primary host untouched, so a retry resolves the primary profile host again', async () => {
      const primaryAgent = new FakeAcpAgent()
      let primaryLoadCalls = 0
      primaryAgent.on('session/load', () => {
        primaryLoadCalls += 1
        if (primaryLoadCalls === 1) throw new Error('session not found')
        return {}
      })
      const primaryHost = createHostFor(primaryAgent)

      const brokenFallbackAgent = new FakeAcpAgent()
      let brokenFallbackNewSessionCalls = 0
      brokenFallbackAgent.on('session/new', () => {
        brokenFallbackNewSessionCalls += 1
        throw new Error('default profile session/new failed')
      })
      const resolveHost = jest.fn(async () =>
        createHostFor(brokenFallbackAgent),
      )

      const runtime = new AcpCliRuntime('hermes', {
        cwd: '/vault',
        resolveHost: async () => primaryHost,
        sessionRecovery: { resolveHost },
      })
      const requestedRef = {
        runtimeId: 'hermes' as const,
        nativeSessionId: 'gone-sess',
        profileId: 'deleted-profile',
      }

      await expect(runtime.openSession(requestedRef)).rejects.toThrow(
        /default profile session\/new failed/,
      )
      expect(primaryLoadCalls).toBe(1)
      expect(brokenFallbackNewSessionCalls).toBe(1)
      expect(resolveHost).toHaveBeenCalledTimes(1)

      // Retry: must resolve the primary profile host again — the failed
      // attempt above must not have adopted the broken candidate as
      // `this.host`.
      const retryHydration = await runtime.openSession(requestedRef)

      expect(retryHydration.ref).toEqual(requestedRef)
      expect(retryHydration.sessionFallback).toBeUndefined()
      expect(primaryLoadCalls).toBe(2)
      // The retry never needed recovery at all — proof it went straight to
      // the primary host rather than the still-broken fallback.
      expect(resolveHost).toHaveBeenCalledTimes(1)
      expect(brokenFallbackNewSessionCalls).toBe(1)

      await runtime.dispose()
    })

    it('ensureReady(): a recovery candidate whose newSession() fails leaves this.host, the fatal listener, and the session binding untouched', async () => {
      const primaryAgent = new FakeAcpAgent()
      primaryAgent.on('session/load', () => {
        throw new Error('session not found')
      })
      const primaryHost = createHostFor(primaryAgent)

      const brokenFallbackAgent = new FakeAcpAgent()
      brokenFallbackAgent.on('session/new', () => {
        throw new Error('default profile session/new failed')
      })

      const runtime = new AcpCliRuntime('hermes', {
        cwd: '/vault',
        resolveHost: async () => primaryHost,
        sessionRecovery: {
          resolveHost: async () => createHostFor(brokenFallbackAgent),
        },
      })
      const events = collectEvents(runtime)
      const requestedRef = {
        runtimeId: 'hermes' as const,
        nativeSessionId: 'gone-sess',
        profileId: 'deleted-profile',
      }

      await expect(
        runtime.ensureReady({ sessionRef: requestedRef }),
      ).rejects.toThrow(/default profile session\/new failed/)

      // Binding untouched: no session was ever actually bound, so a send
      // must still fail with "not ready" instead of silently trying to
      // dispatch onto a half-adopted host/session.
      await expect(runtime.sendTurn({ content: 'hi' })).rejects.toThrow(
        /is not ready/,
      )

      // Fatal listener untouched: a crash on the *primary* host must still
      // surface through the runtime, proving the failed recovery attempt
      // never replaced it with one on the broken candidate.
      primaryAgent.emitExit(1)
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'run_state', state: 'error' }),
      )

      await runtime.dispose()
    })
  })
})

describe('AcpCliRuntime thought level', () => {
  const THOUGHT_LEVEL = {
    type: 'select',
    id: 'thought_level',
    name: 'Deep Thinking',
    category: 'thought_level',
    currentValue: 'enabled',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
      { value: 'enabled', name: 'On (default)' },
    ],
  }

  const autoAwareProfile: Partial<AcpAgentProfile> = {
    autoThoughtLevelValueId: 'enabled',
  }

  const collectConfigWrites = (
    agent: FakeAcpAgent,
  ): { configId: string; value: unknown }[] => {
    const applied: { configId: string; value: unknown }[] = []
    agent.on('session/set_config_option', (message) => {
      const params = message.params as { configId: string; value: unknown }
      applied.push({ configId: params.configId, value: params.value })
      return {
        configOptions: [{ ...THOUGHT_LEVEL, currentValue: params.value }],
      }
    })
    return applied
  }

  const readyRuntime = async (agent: FakeAcpAgent) => {
    agent.on('session/new', () => ({
      sessionId: 'sess-1',
      configOptions: [THOUGHT_LEVEL],
    }))
    const runtime = createRuntime(agent, autoAwareProfile)
    await runtime.ensureReady({})
    return runtime
  }

  it('publishes the agent’s levels and current value onto the configuration', async () => {
    const agent = new FakeAcpAgent()
    const runtime = await readyRuntime(agent)

    const configuration = await runtime.getConfiguration([
      { id: 'm1', label: 'Model One', reasoningEfforts: [] },
    ])

    expect(configuration.reasoningEffort).toBe('enabled')
    expect(configuration.models[0].reasoningEfforts).toEqual([
      { id: 'low' },
      { id: 'high' },
      { id: 'enabled' },
    ])
    await runtime.dispose()
  })

  it('writes a picked level through session/set_config_option', async () => {
    const agent = new FakeAcpAgent()
    const applied = collectConfigWrites(agent)
    const runtime = await readyRuntime(agent)

    const configuration = await runtime.updateConfiguration({
      reasoningEffort: 'high',
    })

    expect(applied).toEqual([{ configId: 'thought_level', value: 'high' }])
    // The agent's reply is what updates local state, not the requested value.
    expect(configuration.reasoningEffort).toBe('high')
    await runtime.dispose()
  })

  /**
   * `auto` is the product's word for "let the agent decide"; the agent spells
   * it with its own value id, which only the profile knows.
   */
  it('translates the product’s auto level to the profile-declared value', async () => {
    const agent = new FakeAcpAgent()
    const applied = collectConfigWrites(agent)
    const runtime = await readyRuntime(agent)

    await runtime.updateConfiguration({ reasoningEffort: 'high' })
    await runtime.updateConfiguration({ reasoningEffort: 'auto' })

    expect(applied.map((write) => write.value)).toEqual(['high', 'enabled'])
    await runtime.dispose()
  })

  it('drops a level the agent never advertised instead of erroring', async () => {
    const agent = new FakeAcpAgent()
    const applied = collectConfigWrites(agent)
    const runtime = await readyRuntime(agent)

    await runtime.updateConfiguration({ reasoningEffort: 'xhigh' })

    expect(applied).toEqual([])
    await runtime.dispose()
  })

  it('sends nothing when the picked level is already current', async () => {
    const agent = new FakeAcpAgent()
    const applied = collectConfigWrites(agent)
    const runtime = await readyRuntime(agent)

    await runtime.updateConfiguration({ reasoningEffort: 'enabled' })

    expect(applied).toEqual([])
    await runtime.dispose()
  })

  it('reports no reasoning surface for an agent without config options', async () => {
    const agent = new FakeAcpAgent()
    agent.on('session/new', () => ({ sessionId: 'sess-1' }))
    const applied = collectConfigWrites(agent)
    const runtime = createRuntime(agent, autoAwareProfile)
    await runtime.ensureReady({})

    const configuration = await runtime.updateConfiguration({
      reasoningEffort: 'high',
    })

    expect(applied).toEqual([])
    expect(configuration.reasoningEffort).toBeNull()
    await runtime.dispose()
  })
})
