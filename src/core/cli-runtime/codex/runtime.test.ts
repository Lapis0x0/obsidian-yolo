import { ToolCallResponseStatus } from '../../../types/tool-call.types'

import { CodexAppServerHost, CodexAppServerHostPool } from './host'
import type { CodexProcessExitListener, CodexProcessLike } from './process'
import { CodexCliRuntime } from './runtime'

class RpcFakeProcess implements CodexProcessLike {
  responses: unknown[] = []
  serverResponses: Array<{
    id: string | number
    result?: unknown
    error?: unknown
  }> = []
  errors: unknown[] = []
  requests: Array<{ method: string; params: Record<string, unknown> }> = []
  threadPages: Array<Array<typeof this.thread>> = []
  threadIdForStart?: (params: Record<string, unknown>) => string
  stderr = ''
  private lineListener: ((line: string) => void) | null = null
  private exitListener: CodexProcessExitListener | null = null
  readonly thread = {
    id: 'thread-1',
    preview: 'First prompt',
    path: '/sessions/thread-1.jsonl',
    cwd: '/vault',
    createdAt: 10,
    updatedAt: 20,
    name: null as string | null,
    turns: [],
  }

  write(line: string): void {
    const request = JSON.parse(line) as {
      id?: string | number
      method?: string
      result?: unknown
      error?: unknown
      params?: Record<string, unknown>
    }
    if (request.result !== undefined) {
      this.responses.push(request.result)
      if (request.id !== undefined) {
        this.serverResponses.push({ id: request.id, result: request.result })
      }
      return
    }
    if (request.error !== undefined) {
      this.errors.push(request.error)
      if (request.id !== undefined) {
        this.serverResponses.push({ id: request.id, error: request.error })
      }
      return
    }
    if (request.id === undefined || !request.method) return
    this.requests.push({ method: request.method, params: request.params ?? {} })
    const pageIndex =
      typeof request.params?.cursor === 'string'
        ? Number(request.params.cursor)
        : 0
    const threadPages =
      this.threadPages.length > 0 ? this.threadPages : [[this.thread]]
    const result =
      request.method === 'thread/list'
        ? {
            data: threadPages[pageIndex] ?? [],
            nextCursor:
              pageIndex + 1 < threadPages.length ? String(pageIndex + 1) : null,
          }
        : request.method === 'model/list'
          ? {
              data: [
                {
                  id: 'luna',
                  model: 'luna',
                  displayName: 'Luna',
                  description: '',
                  hidden: false,
                  supportedReasoningEfforts: [
                    { reasoningEffort: 'max', description: '' },
                  ],
                  defaultReasoningEffort: 'max',
                  isDefault: true,
                },
              ],
              nextCursor: null,
            }
          : request.method === 'thread/read'
            ? { thread: this.thread }
            : request.method === 'thread/start' ||
                request.method === 'thread/resume'
              ? {
                  thread: {
                    ...this.thread,
                    id:
                      this.threadIdForStart?.(request.params ?? {}) ??
                      this.thread.id,
                  },
                }
              : request.method === 'turn/start'
                ? {
                    turn: {
                      id: 'turn-1',
                      items: [],
                      status: 'inProgress',
                      error: null,
                    },
                  }
                : {}
    queueMicrotask(() => this.emit({ jsonrpc: '2.0', id: request.id, result }))
  }
  onLine(listener: (line: string) => void): () => void {
    this.lineListener = listener
    return () => {
      this.lineListener = null
    }
  }
  onExit(listener: CodexProcessExitListener): () => void {
    this.exitListener = listener
    return () => {
      if (this.exitListener === listener) this.exitListener = null
    }
  }
  getStderrSnapshot(): string {
    return this.stderr
  }
  async shutdown(): Promise<void> {}
  emit(message: unknown): void {
    this.lineListener?.(JSON.stringify(message))
  }
  emitExit(code: number | null = 1): void {
    this.exitListener?.(code, null)
  }
}

describe('CodexCliRuntime', () => {
  it('shares one initialized app-server host across native sessions', async () => {
    const processes: RpcFakeProcess[] = []
    const pool = new CodexAppServerHostPool({
      cwd: '/vault',
      createProcess: async () => {
        const process = new RpcFakeProcess()
        processes.push(process)
        return process
      },
    })
    const hostA = await pool.acquire()
    const hostB = await pool.acquire()
    await Promise.all([hostA.ensureReady(), hostB.ensureReady()])

    expect(hostB).toBe(hostA)
    expect(processes).toHaveLength(1)
    await pool.dispose()
  })

  it('does not inject YOLO prompts or Skills into native Codex requests', async () => {
    const process = new RpcFakeProcess()
    const host = new CodexAppServerHost({
      cwd: '/vault',
      createProcess: async () => process,
    })
    const runtime = new CodexCliRuntime({
      cwd: '/vault',
      resolveHost: async () => host,
    })

    await runtime.ensureReady({})
    await runtime.sendTurn({
      content: 'Review this change.',
      selectedSkillNames: ['review'],
    })

    expect(
      process.requests.find((request) => request.method === 'thread/start')
        ?.params.developerInstructions,
    ).toBeUndefined()
    expect(
      process.requests.some(
        (request) => request.method === 'skills/extraRoots/set',
      ),
    ).toBe(false)
    expect(
      process.requests.find((request) => request.method === 'turn/start')
        ?.params.input,
    ).toEqual([
      { type: 'text', text: 'Review this change.', text_elements: [] },
    ])
  })

  it('routes interleaved shared-host events and cancellation by thread', async () => {
    const process = new RpcFakeProcess()
    let nextThread = 0
    process.threadIdForStart = () =>
      nextThread++ === 0 ? 'thread-a' : 'thread-b'
    const host = new CodexAppServerHost({
      cwd: '/vault',
      createProcess: async () => process,
    })
    const runtimeA = new CodexCliRuntime({
      cwd: '/vault',
      resolveHost: async () => host,
    })
    const runtimeB = new CodexCliRuntime({
      cwd: '/vault',
      resolveHost: async () => host,
    })
    const messagesA: string[] = []
    const messagesB: string[] = []
    const approvalsA: string[] = []
    const approvalsB: string[] = []
    runtimeA.subscribe((event) => {
      if (
        event.type === 'message_upsert' &&
        event.message.role === 'assistant'
      ) {
        if (event.message.content) messagesA.push(event.message.content)
      }
      if (
        event.type === 'run_state' &&
        event.state === 'waiting_for_approval'
      ) {
        approvalsA.push(event.state)
      }
    })
    runtimeB.subscribe((event) => {
      if (
        event.type === 'message_upsert' &&
        event.message.role === 'assistant'
      ) {
        if (event.message.content) messagesB.push(event.message.content)
      }
      if (
        event.type === 'run_state' &&
        event.state === 'waiting_for_approval'
      ) {
        approvalsB.push(event.state)
      }
    })

    await Promise.all([runtimeA.ensureReady({}), runtimeB.ensureReady({})])
    process.emit({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: { threadId: 'thread-a', turn: { id: 'turn-a' } },
    })
    process.emit({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: { threadId: 'thread-b', turn: { id: 'turn-b' } },
    })
    process.emit({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-b',
        itemId: 'message-b',
        delta: 'B',
      },
    })
    process.emit({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-a',
        itemId: 'message-a',
        delta: 'A',
      },
    })
    process.emit({
      jsonrpc: '2.0',
      id: 101,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-a',
        turnId: 'turn-a',
        itemId: 'item-a',
        command: 'echo a',
      },
    })
    process.emit({
      jsonrpc: '2.0',
      id: 202,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-b',
        turnId: 'turn-b',
        itemId: 'item-b',
        command: 'echo b',
      },
    })
    await runtimeA.respondApproval({
      requestId: 'item-a',
      decision: 'approve_once',
    })
    await runtimeA.cancel()

    expect(messagesA).toEqual(['A'])
    expect(messagesB).toEqual(['B'])
    expect(approvalsA).toEqual(['waiting_for_approval'])
    expect(approvalsB).toEqual(['waiting_for_approval'])
    expect(process.serverResponses).toContainEqual({
      id: 101,
      result: { decision: 'accept' },
    })
    expect(
      process.serverResponses.some((response) => response.id === 202),
    ).toBe(false)
    expect(process.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-a', turnId: 'turn-a' },
    })
    expect(
      process.requests.filter((request) => request.method === 'initialize'),
    ).toHaveLength(1)
  })

  it('lists vault sessions and starts a native thread', async () => {
    const process = new RpcFakeProcess()
    const runtime = new CodexCliRuntime({
      cwd: '/vault',
      createProcess: async () => process,
    })
    await expect(runtime.listSessions()).resolves.toMatchObject([
      {
        title: 'First prompt',
        ref: { runtimeId: 'codex', nativeSessionId: 'thread-1' },
      },
    ])

    const events: string[] = []
    runtime.subscribe((event) => events.push(event.type))
    await runtime.ensureReady({})
    expect(events).toContain('session_bound')
  })

  it('renames only threads without a provider-native name', async () => {
    const process = new RpcFakeProcess()
    const runtime = new CodexCliRuntime({
      cwd: '/vault',
      createProcess: async () => process,
    })
    const ref = { runtimeId: 'codex' as const, nativeSessionId: 'thread-1' }

    await expect(
      runtime.renameSessionIfPlaceholder(ref, 'Generated title'),
    ).resolves.toBe('renamed')
    expect(process.requests).toContainEqual({
      method: 'thread/read',
      params: { threadId: 'thread-1', includeTurns: false },
    })
    expect(process.requests).toContainEqual({
      method: 'thread/name/set',
      params: { threadId: 'thread-1', name: 'Generated title' },
    })

    process.thread.name = 'Manual title'
    process.requests.length = 0
    await expect(
      runtime.renameSessionIfPlaceholder(ref, 'Replacement title'),
    ).resolves.toBe('preserved')
    expect(
      process.requests.some((request) => request.method === 'thread/name/set'),
    ).toBe(false)
  })

  it('requests visible reasoning summaries and streams summary and content deltas', async () => {
    const process = new RpcFakeProcess()
    const runtime = new CodexCliRuntime({
      cwd: '/vault',
      createProcess: async () => process,
    })
    const reasoning: string[] = []
    runtime.subscribe((event) => {
      if (
        event.type === 'message_upsert' &&
        event.message.role === 'assistant' &&
        event.message.reasoning
      ) {
        reasoning.push(event.message.reasoning)
      }
    })
    await runtime.ensureReady({})
    await runtime.updateConfiguration({ reasoningEffort: 'max' })
    await runtime.sendTurn({ content: 'think carefully' })

    expect(
      process.requests.find((request) => request.method === 'turn/start')
        ?.params,
    ).toMatchObject({ effort: 'max', summary: 'auto' })

    process.emit({
      jsonrpc: '2.0',
      method: 'item/reasoning/summaryTextDelta',
      params: {
        itemId: 'reasoning-1',
        summaryIndex: 0,
        delta: 'Public summary',
      },
    })
    process.emit({
      jsonrpc: '2.0',
      method: 'item/reasoning/textDelta',
      params: {
        itemId: 'reasoning-1',
        contentIndex: 0,
        delta: 'Public reasoning text',
      },
    })

    expect(reasoning).toEqual([
      'Public summary',
      'Public summary\n\nPublic reasoning text',
    ])
  })

  it('paginates all sessions and exposes only vault root or descendant cwd values', async () => {
    const process = new RpcFakeProcess()
    process.threadPages = [
      [
        { ...process.thread, id: 'root', cwd: '/vault' },
        {
          ...process.thread,
          id: 'descendant',
          cwd: '/vault/projects/one',
        },
        { ...process.thread, id: 'sibling', cwd: '/other' },
      ],
      [{ ...process.thread, id: 'prefix-spoof', cwd: '/vault-copy' }],
    ]
    const runtime = new CodexCliRuntime({
      cwd: '/vault',
      createProcess: async () => process,
    })

    await expect(runtime.listSessions()).resolves.toMatchObject([
      { ref: { nativeSessionId: 'root' }, cwd: '/vault' },
      {
        ref: { nativeSessionId: 'descendant' },
        cwd: '/vault/projects/one',
      },
    ])
    const listRequests = process.requests.filter(
      (request) => request.method === 'thread/list',
    )
    expect(listRequests).toHaveLength(2)
    expect(listRequests[0].params).not.toHaveProperty('cwd')
    expect(listRequests[1].params).toMatchObject({ cursor: '1' })
  })

  it('surfaces server approvals and routes the UI decision back by tool id', async () => {
    const process = new RpcFakeProcess()
    const runtime = new CodexCliRuntime({
      cwd: '/vault',
      createProcess: async () => process,
    })
    const events: string[] = []
    runtime.subscribe((event) => {
      if (event.type === 'run_state') events.push(event.state)
    })
    await runtime.ensureReady({})
    process.emit({
      jsonrpc: '2.0',
      id: 91,
      method: 'item/commandExecution/requestApproval',
      params: {
        approvalId: 'approval-1',
        itemId: 'command-1',
        command: 'pwd',
        cwd: '/vault',
      },
    })
    expect(events).toContain('waiting_for_approval')

    await expect(
      runtime.respondApproval({
        requestId: 'command-1',
        decision: 'approve_for_session',
      }),
    ).resolves.toBe(true)
    expect(process.responses).toContainEqual({ decision: 'acceptForSession' })
    await expect(
      runtime.respondApproval({
        requestId: 'approval-1',
        decision: 'reject',
      }),
    ).resolves.toBe(false)
  })

  it('uses method-specific file and permission approval response schemas', async () => {
    const process = new RpcFakeProcess()
    const runtime = new CodexCliRuntime({
      cwd: '/vault',
      createProcess: async () => process,
    })
    await runtime.ensureReady({})

    process.emit({
      jsonrpc: '2.0',
      id: 101,
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'file-1', reason: 'edit file' },
    })
    await expect(
      runtime.respondApproval({ requestId: 'file-1', decision: 'reject' }),
    ).resolves.toBe(true)
    expect(process.responses).toContainEqual({ decision: 'decline' })

    const permissions = {
      network: { enabled: true },
      fileSystem: { read: null, write: ['/vault/shared'] },
    }
    process.emit({
      jsonrpc: '2.0',
      id: 102,
      method: 'item/permissions/requestApproval',
      params: { itemId: 'permissions-once', permissions },
    })
    await expect(
      runtime.respondApproval({
        requestId: 'permissions-once',
        decision: 'approve_once',
      }),
    ).resolves.toBe(true)
    expect(process.responses).toContainEqual({
      permissions,
      scope: 'turn',
    })

    process.emit({
      jsonrpc: '2.0',
      id: 103,
      method: 'item/permissions/requestApproval',
      params: { itemId: 'permissions-session', permissions },
    })
    await runtime.respondApproval({
      requestId: 'permissions-session',
      decision: 'approve_for_session',
    })
    expect(process.responses).toContainEqual({
      permissions,
      scope: 'session',
    })

    process.emit({
      jsonrpc: '2.0',
      id: 104,
      method: 'item/permissions/requestApproval',
      params: { itemId: 'permissions-reject', permissions },
    })
    await runtime.respondApproval({
      requestId: 'permissions-reject',
      decision: 'reject',
    })
    expect(process.errors).toContainEqual({
      code: -32000,
      message: 'User denied the requested permissions.',
      data: null,
    })
  })

  it('invalidates a dead transport during a turn and rebuilds it on next readiness', async () => {
    const first = new RpcFakeProcess()
    const second = new RpcFakeProcess()
    const createProcess = jest
      .fn<Promise<CodexProcessLike>, []>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const runtime = new CodexCliRuntime({ cwd: '/vault', createProcess })
    const runStates: Array<{ state: string; error?: string }> = []
    runtime.subscribe((event) => {
      if (event.type === 'run_state') runStates.push(event)
    })
    await runtime.ensureReady({})
    await runtime.sendTurn({
      sessionRef: { runtimeId: 'codex', nativeSessionId: 'thread-1' },
      content: 'keep working',
    })

    first.stderr = 'process crashed'
    first.emitExit()
    await Promise.resolve()
    expect(runStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'error',
          error: 'Codex app-server exited: process crashed',
        }),
      ]),
    )

    await runtime.ensureReady({
      sessionRef: { runtimeId: 'codex', nativeSessionId: 'thread-1' },
    })
    expect(createProcess).toHaveBeenCalledTimes(2)
    expect(second.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'thread/resume' }),
      ]),
    )
  })

  it('maps Codex user input requests to the shared Ask User card contract', async () => {
    const process = new RpcFakeProcess()
    const runtime = new CodexCliRuntime({
      cwd: '/vault',
      createProcess: async () => process,
    })
    const events: unknown[] = []
    runtime.subscribe((event) => events.push(event))
    await runtime.ensureReady({})

    process.emit({
      jsonrpc: '2.0',
      id: 92,
      method: 'item/tool/requestUserInput',
      params: {
        itemId: 'question-tool',
        questions: [
          {
            id: 'choice',
            question: 'Choose one?',
            options: [{ label: 'A' }, { label: 'B' }],
          },
        ],
      },
    })

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message_upsert',
          message: expect.objectContaining({
            role: 'tool',
            toolCalls: [
              expect.objectContaining({
                request: expect.objectContaining({
                  id: 'question-tool',
                  name: 'yolo_local__ask_user_question',
                }),
                response: { status: ToolCallResponseStatus.AwaitingUserInput },
              }),
            ],
          }),
        }),
      ]),
    )
    await expect(
      runtime.respondQuestion({
        requestId: 'question-tool',
        answer: {
          type: 'user_answers',
          answers: [{ id: 'choice', value: 'A' }],
        },
      }),
    ).resolves.toBe(true)
    expect(process.responses).toContainEqual({
      answers: { choice: { answers: ['A'] } },
    })
  })
})
