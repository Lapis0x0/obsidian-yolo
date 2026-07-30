import type {
  CanUseTool,
  Options,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { Platform } from 'obsidian'

import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import type { CliRuntimeEvent } from '../types'

import { ClaudeCliRuntime } from './ClaudeCliRuntime'
import type {
  ClaudeProcessSupport,
  ClaudeSdkModule,
  ClaudeSdkQuery,
} from './types'

type QueryInput = {
  prompt: AsyncIterable<SDKUserMessage> | string
  options?: Options
}

class FakeQuery implements ClaudeSdkQuery {
  readonly interrupt = jest.fn(async () => undefined)
  readonly initializationResult = jest.fn(async () => ({}))
  readonly close = jest.fn()

  private messages: SDKMessage[] = []
  private waiting:
    | ((result: IteratorResult<SDKMessage, void>) => void)
    | undefined
  private closed = false

  push(message: SDKMessage): void {
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve({ done: false, value: message })
      return
    }
    this.messages.push(message)
  }

  next(): Promise<IteratorResult<SDKMessage, void>> {
    const message = this.messages.shift()
    if (message) {
      return Promise.resolve({ done: false, value: message })
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined })
    }
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }

  return(): Promise<IteratorResult<SDKMessage, void>> {
    this.closed = true
    this.waiting?.({ done: true, value: undefined })
    this.waiting = undefined
    return Promise.resolve({ done: true, value: undefined })
  }

  throw(error?: unknown): Promise<IteratorResult<SDKMessage, void>> {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    )
  }

  [Symbol.asyncIterator](): ClaudeSdkQuery {
    return this
  }
}

const createSdk = () => {
  const queryInstance = new FakeQuery()
  const queryInputs: QueryInput[] = []
  const listSessions = jest.fn<
    Promise<SDKSessionInfo[]>,
    [options?: { dir?: string }]
  >(async () => [])
  const getSessionMessages = jest.fn<
    Promise<SessionMessage[]>,
    [sessionId: string, options?: { dir?: string }]
  >(async () => [])
  const query = jest.fn<ClaudeSdkQuery, [input: QueryInput]>((input) => {
    queryInputs.push(input)
    return queryInstance
  })
  const sdk: ClaudeSdkModule = {
    query,
    listSessions,
    getSessionMessages,
  }
  return {
    sdk,
    query,
    queryInputs,
    queryInstance,
    listSessions,
    getSessionMessages,
  }
}

const processSupport: ClaudeProcessSupport = {
  cliPath: '/opt/homebrew/bin/claude',
  env: { PATH: '/opt/homebrew/bin:/usr/bin' },
  spawnClaudeCodeProcess: jest.fn(),
}

const flushPromises = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const assistantMessage = (
  content: Array<Record<string, unknown>>,
): SDKMessage =>
  ({
    type: 'assistant',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: 'assistant-uuid',
    session_id: 'session-1',
  }) as unknown as SDKMessage

describe('ClaudeCliRuntime', () => {
  const originalIsDesktop = Platform.isDesktop

  afterEach(() => {
    Platform.isDesktop = originalIsDesktop
  })

  it('gates SDK and Node support loading on desktop availability', async () => {
    Platform.isDesktop = false
    const { sdk } = createSdk()
    const loadSdk = jest.fn(async () => sdk)
    const resolveProcessSupport = jest.fn(async () => processSupport)
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk,
      resolveProcessSupport,
    })

    await expect(runtime.listSessions()).rejects.toThrow(
      /only available on desktop/,
    )
    await expect(
      runtime.ensureReady({
        assistant: {
          systemPrompt: '',
          enabledSkillNames: [],
        },
      }),
    ).rejects.toThrow(/only available on desktop/)
    expect(loadSdk).not.toHaveBeenCalled()
    expect(resolveProcessSupport).not.toHaveBeenCalled()
  })

  it('discovers and hydrates native sessions for the current vault', async () => {
    const { sdk, listSessions, getSessionMessages } = createSdk()
    listSessions.mockResolvedValue([
      {
        sessionId: 'session-1',
        summary: 'Native title',
        firstPrompt: 'First prompt',
        lastModified: 200,
        createdAt: 100,
        cwd: '/vault',
      },
    ])
    getSessionMessages.mockResolvedValue([
      {
        type: 'user',
        uuid: 'user-1',
        session_id: 'session-1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'user', content: 'Run the tests' },
      },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: 'session-1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          id: 'msg_history',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Running them.' },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'npm test' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'result-1',
        session_id: 'session-1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'All tests passed',
            },
          ],
        },
      },
    ] as SessionMessage[])

    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await expect(runtime.listSessions()).resolves.toEqual([
      {
        ref: { runtimeId: 'claude-code', nativeSessionId: 'session-1' },
        title: 'Native title',
        preview: 'First prompt',
        createdAt: 100,
        updatedAt: 200,
        cwd: '/vault',
      },
    ])
    const hydration = await runtime.openSession({
      runtimeId: 'claude-code',
      nativeSessionId: 'session-1',
    })

    expect(listSessions).toHaveBeenCalledWith({ dir: '/vault' })
    expect(getSessionMessages).toHaveBeenCalledWith('session-1', {
      dir: '/vault',
    })
    expect(hydration.messages).toHaveLength(3)
    expect(hydration.messages[0]).toMatchObject({
      role: 'user',
      id: 'user-1',
      promptContent: 'Run the tests',
    })
    expect(hydration.messages[1]).toMatchObject({
      role: 'assistant',
      id: 'assistant-1',
      content: 'Running them.',
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'Bash',
          arguments: { kind: 'complete', value: { command: 'npm test' } },
        },
      ],
    })
    expect(hydration.messages[2]).toMatchObject({
      role: 'tool',
      toolCalls: [
        {
          request: { id: 'tool-1', name: 'Bash' },
          response: {
            status: ToolCallResponseStatus.Success,
            data: { type: 'text', text: 'All tests passed' },
          },
        },
      ],
    })
  })

  it('keeps one streaming query across turns and resumes the native session', async () => {
    const { sdk, query, queryInputs } = createSdk()
    const resolvePluginPaths = jest.fn(async () => [
      '/vault/.yolo-cache/claude-plugin',
    ])
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
      resolvePluginPaths,
    })
    const readyInput = {
      sessionRef: {
        runtimeId: 'claude-code' as const,
        nativeSessionId: 'session-1',
      },
      assistant: {
        assistantId: 'assistant-1',
        systemPrompt: 'Be precise.',
        enabledSkillNames: ['review'],
      },
    }

    await runtime.ensureReady(readyInput)
    await runtime.ensureReady(readyInput)
    await runtime.sendTurn({
      sessionRef: readyInput.sessionRef,
      content: 'First turn',
    })
    await runtime.sendTurn({
      sessionRef: readyInput.sessionRef,
      content: 'Second turn',
    })

    expect(query).toHaveBeenCalledTimes(1)
    expect(resolvePluginPaths).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      enabledSkillNames: ['review'],
    })
    expect(queryInputs[0].options).toMatchObject({
      cwd: '/vault',
      pathToClaudeCodeExecutable: '/opt/homebrew/bin/claude',
      resume: 'session-1',
      includePartialMessages: true,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'Be precise.',
      },
      plugins: [{ type: 'local', path: '/vault/.yolo-cache/claude-plugin' }],
    })
    const prompt = queryInputs[0].prompt
    expect(typeof prompt).not.toBe('string')
    if (typeof prompt === 'string') return
    const iterator = prompt[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'user', message: { content: 'First turn' } },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'user', message: { content: 'Second turn' } },
    })
  })

  it('leaves enabled skill names unapplied when no plugin provider exists', async () => {
    const { sdk, queryInputs } = createSdk()
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await runtime.ensureReady({
      assistant: {
        systemPrompt: '',
        enabledSkillNames: ['not-yet-materialized'],
      },
    })

    expect(queryInputs[0].options?.plugins).toBeUndefined()
  })

  it('surfaces SDK initialization failures and closes the failed query', async () => {
    const { sdk, queryInstance } = createSdk()
    queryInstance.initializationResult.mockRejectedValueOnce(
      new Error('Claude authentication failed'),
    )
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await expect(
      runtime.ensureReady({
        assistant: { systemPrompt: '', enabledSkillNames: [] },
      }),
    ).rejects.toThrow('Claude authentication failed')
    expect(queryInstance.close).toHaveBeenCalledTimes(1)
  })

  it('deduplicates the final assistant text after partial streaming', async () => {
    const { sdk, queryInstance } = createSdk()
    const events: CliRuntimeEvent[] = []
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    runtime.subscribe((event) => events.push(event))
    await runtime.ensureReady({
      assistant: { systemPrompt: '', enabledSkillNames: [] },
    })

    queryInstance.push({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
      parent_tool_use_id: null,
      uuid: 'stream-1',
      session_id: 'session-1',
    } as unknown as SDKMessage)
    queryInstance.push({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
      parent_tool_use_id: null,
      uuid: 'stream-2',
      session_id: 'session-1',
    } as unknown as SDKMessage)
    queryInstance.push(assistantMessage([{ type: 'text', text: 'Hello' }]))
    queryInstance.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Hello',
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: 'standard',
      },
      modelUsage: {},
      permission_denials: [],
      uuid: 'result-1',
      session_id: 'session-1',
    } as unknown as SDKMessage)
    await flushPromises()

    const assistantUpserts = events.filter(
      (event) =>
        event.type === 'message_upsert' && event.message.role === 'assistant',
    )
    expect(assistantUpserts).not.toHaveLength(0)
    expect(assistantUpserts.at(-1)).toMatchObject({
      type: 'message_upsert',
      message: {
        role: 'assistant',
        content: 'Hello',
        metadata: { generationState: 'completed' },
      },
    })
    expect(
      assistantUpserts.some(
        (event) =>
          event.type === 'message_upsert' &&
          event.message.role === 'assistant' &&
          event.message.content === 'HelloHello',
      ),
    ).toBe(false)
  })

  it('bridges approvals and AskUserQuestion responses back to the SDK', async () => {
    const { sdk, queryInputs } = createSdk()
    const events: CliRuntimeEvent[] = []
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    runtime.subscribe((event) => events.push(event))
    await runtime.ensureReady({
      assistant: { systemPrompt: '', enabledSkillNames: [] },
    })
    const canUseTool = queryInputs[0].options?.canUseTool as CanUseTool

    const approval = canUseTool(
      'Bash',
      { command: 'npm test' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
        requestId: 'request-1',
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
            behavior: 'allow',
            destination: 'projectSettings',
          },
        ],
      },
    )
    await flushPromises()
    await runtime.respondApproval({
      requestId: 'tool-1',
      decision: 'approve_for_session',
    })
    await expect(approval).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { command: 'npm test' },
      updatedPermissions: [{ destination: 'session' }],
    })

    const question = canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'Continue?' }] },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-2',
        requestId: 'request-2',
      },
    )
    await flushPromises()
    await runtime.respondQuestion({
      requestId: 'request-2',
      answer: { Continue: 'Yes' },
    })
    await expect(question).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: {
        questions: [{ question: 'Continue?', isOther: true }],
        answers: { Continue: 'Yes' },
      },
    })

    const approvalWithoutSuggestion = canUseTool(
      'Write',
      { file_path: '/vault/note.md' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-3',
        requestId: 'request-3',
      },
    )
    await flushPromises()
    await runtime.respondApproval({
      requestId: 'request-3',
      decision: 'approve_for_session',
    })
    await expect(approvalWithoutSuggestion).resolves.toMatchObject({
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Write' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    })

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'run_state',
          state: 'waiting_for_approval',
        }),
        expect.objectContaining({
          type: 'run_state',
          state: 'waiting_for_user',
        }),
        expect.objectContaining({
          type: 'message_upsert',
          message: expect.objectContaining({
            role: 'tool',
            toolCalls: [
              expect.objectContaining({
                response: {
                  status: ToolCallResponseStatus.AwaitingUserInput,
                },
              }),
            ],
          }),
        }),
      ]),
    )
  })

  it('interrupts without discarding the persistent query', async () => {
    const { sdk, query, queryInstance } = createSdk()
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    const readyInput = {
      assistant: { systemPrompt: '', enabledSkillNames: [] },
    }
    await runtime.ensureReady(readyInput)
    await runtime.sendTurn({ content: 'Start' })
    await runtime.cancel()
    await runtime.ensureReady(readyInput)
    await runtime.sendTurn({ content: 'Continue' })

    expect(queryInstance.interrupt).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
  })
})
