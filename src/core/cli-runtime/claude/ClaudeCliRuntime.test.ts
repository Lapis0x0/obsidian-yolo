import type {
  CanUseTool,
  Options,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
} from '@yolo/claude-agent-sdk-runtime'
import { Platform } from 'obsidian'

import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { CliConversationController } from '../conversation-controller'
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
  readonly initializationResult = jest.fn(async () => ({
    commands: [],
    agents: [],
    output_style: '',
    available_output_styles: [],
    models: [],
    account: {
      email: '',
      organization: '',
      subscriptionType: '',
      tokenSource: 'none' as const,
    },
  }))
  readonly supportedModels = jest.fn(async () => [])
  readonly setModel = jest.fn(async () => undefined)
  readonly applyFlagSettings = jest.fn(async () => undefined)
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
    [options?: { dir?: string; limit?: number; offset?: number }]
  >(async () => [])
  const getSessionMessages = jest.fn<
    Promise<SessionMessage[]>,
    [sessionId: string, options?: { dir?: string }]
  >(async () => [])
  const getSessionInfo = jest.fn<
    Promise<SDKSessionInfo | undefined>,
    [sessionId: string, options?: { dir?: string }]
  >(async () => undefined)
  const renameSession = jest.fn<
    Promise<void>,
    [sessionId: string, title: string, options?: { dir?: string }]
  >(async () => undefined)
  const query = jest.fn<ClaudeSdkQuery, [input: QueryInput]>((input) => {
    queryInputs.push(input)
    return queryInstance
  })
  const sdk: ClaudeSdkModule = {
    query,
    listSessions,
    getSessionInfo,
    getSessionMessages,
    renameSession,
  }
  return {
    sdk,
    query,
    queryInputs,
    queryInstance,
    listSessions,
    getSessionInfo,
    getSessionMessages,
    renameSession,
  }
}

const processSupport: ClaudeProcessSupport = {
  cliPath: '/opt/homebrew/bin/claude',
  env: { PATH: '/opt/homebrew/bin:/usr/bin' },
  createAbortController: () => new AbortController(),
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
    await expect(runtime.ensureReady({})).rejects.toThrow(
      /only available on desktop/,
    )
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
      {
        type: 'assistant',
        uuid: 'assistant-question',
        session_id: 'session-1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          id: 'msg_question',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'question-tool',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    id: 'choice',
                    question: 'Choose one?',
                    options: [
                      { label: 'A', description: 'Option A' },
                      { label: 'B', description: 'Option B' },
                    ],
                    multiSelect: false,
                  },
                ],
              },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'question-result',
        session_id: 'session-1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'question-tool',
              content: 'Answered',
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

    expect(listSessions).toHaveBeenCalledWith({ limit: 100, offset: 0 })
    expect(getSessionMessages).toHaveBeenCalledWith('session-1')
    expect(hydration.messages).toHaveLength(5)
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
    expect(hydration.messages[3]).toMatchObject({
      role: 'assistant',
      toolCallRequests: [
        {
          id: 'question-tool',
          name: 'yolo_local__ask_user_question',
          arguments: {
            kind: 'complete',
            value: {
              questions: [
                {
                  id: 'choice',
                  prompt: 'Choose one?',
                  inputType: 'single_select',
                  options: [
                    { id: 'A', label: 'A' },
                    { id: 'B', label: 'B' },
                  ],
                },
              ],
            },
          },
        },
      ],
    })
    expect(hydration.messages[4]).toMatchObject({
      role: 'tool',
      toolCalls: [
        {
          request: {
            id: 'question-tool',
            name: 'yolo_local__ask_user_question',
          },
        },
      ],
    })
  })

  it('renames only first-prompt placeholders from fresh session metadata', async () => {
    const { sdk, getSessionInfo, renameSession } = createSdk()
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    const ref = {
      runtimeId: 'claude-code' as const,
      nativeSessionId: 'session-1',
    }
    getSessionInfo.mockResolvedValue({
      sessionId: 'session-1',
      summary: 'First prompt',
      firstPrompt: 'First prompt',
      lastModified: 1,
      cwd: '/vault',
    })

    await expect(
      runtime.renameSessionIfPlaceholder(ref, 'Generated title'),
    ).resolves.toBe('renamed')
    expect(getSessionInfo).toHaveBeenCalledWith('session-1', { dir: '/vault' })
    expect(renameSession).toHaveBeenCalledWith(
      'session-1',
      'Generated title',
      { dir: '/vault' },
    )

    getSessionInfo.mockResolvedValue({
      sessionId: 'session-1',
      summary: 'First prompt',
      firstPrompt: 'First prompt',
      customTitle: 'First prompt',
      lastModified: 1,
      cwd: '/vault',
    })
    renameSession.mockClear()

    await expect(
      runtime.renameSessionIfPlaceholder(ref, 'Generated title'),
    ).resolves.toBe('preserved')
    expect(renameSession).not.toHaveBeenCalled()
  })

  it('paginates global discovery and exposes only root or descendant sessions', async () => {
    const { sdk, listSessions } = createSdk()
    const outsideSessions = Array.from(
      { length: 96 },
      (_, index): SDKSessionInfo => ({
        sessionId: `outside-${index}`,
        summary: `Outside ${index}`,
        lastModified: index,
        cwd: `/outside/${index}`,
      }),
    )
    listSessions.mockImplementation(async (options) => {
      if ((options?.offset ?? 0) === 0) {
        return [
          {
            sessionId: 'root',
            summary: 'Root',
            lastModified: 4,
            cwd: '/vault',
          },
          {
            sessionId: 'descendant',
            summary: 'Descendant',
            lastModified: 3,
            cwd: '/vault/projects/one',
          },
          {
            sessionId: 'sibling',
            summary: 'Sibling',
            lastModified: 2,
            cwd: '/other',
          },
          {
            sessionId: 'prefix-spoof',
            summary: 'Prefix spoof',
            lastModified: 1,
            cwd: '/vault-copy',
          },
          ...outsideSessions,
        ]
      }
      return [
        {
          sessionId: 'second-page-descendant',
          summary: 'Second page',
          lastModified: 5,
          cwd: '/vault/projects/two',
        },
      ]
    })
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await expect(runtime.listSessions()).resolves.toMatchObject([
      { ref: { nativeSessionId: 'root' }, cwd: '/vault' },
      {
        ref: { nativeSessionId: 'descendant' },
        cwd: '/vault/projects/one',
      },
      {
        ref: { nativeSessionId: 'second-page-descendant' },
        cwd: '/vault/projects/two',
      },
    ])
    expect(listSessions).toHaveBeenNthCalledWith(2, {
      limit: 100,
      offset: 100,
    })
  })

  it('keeps one streaming query across turns and resumes the native session', async () => {
    const { sdk, query, queryInputs } = createSdk()
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    const readyInput = {
      sessionRef: {
        runtimeId: 'claude-code' as const,
        nativeSessionId: 'session-1',
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
    expect(queryInputs[0].options).toMatchObject({
      cwd: '/vault',
      pathToClaudeCodeExecutable: '/opt/homebrew/bin/claude',
      resume: 'session-1',
      includePartialMessages: true,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
      },
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

  it('binds a generated session after initialization without waiting for an init event', async () => {
    const { sdk, query, queryInputs, queryInstance } = createSdk()
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    const events: CliRuntimeEvent[] = []
    runtime.subscribe((event) => events.push(event))
    const controller = new CliConversationController(runtime)

    await controller.ensureReady()
    const ref = controller.getSnapshot().sessionRef
    expect(ref).toMatchObject({ runtimeId: 'claude-code' })
    expect(ref?.nativeSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    expect(queryInputs[0].options).toMatchObject({
      sessionId: ref?.nativeSessionId,
    })
    expect(queryInputs[0].options?.resume).toBeUndefined()
    await controller.ensureReady()
    expect(query).toHaveBeenCalledTimes(1)

    await controller.sendTurn({
      userMessage: {
        role: 'user',
        id: 'user-first',
        content: null,
        promptContent: 'First turn',
        mentionables: [],
      },
      content: 'First turn',
    })
    const prompt = queryInputs[0].prompt
    if (typeof prompt === 'string') throw new Error('Expected streaming prompt')
    await expect(prompt[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: {
        type: 'user',
        session_id: ref?.nativeSessionId,
        message: { content: 'First turn' },
      },
    })

    queryInstance.push({
      type: 'system',
      subtype: 'init',
      session_id: ref?.nativeSessionId,
    } as SDKMessage)
    queryInstance.push({
      type: 'system',
      subtype: 'init',
      session_id: 'mismatched-session',
    } as SDKMessage)
    await flushPromises()
    expect(controller.getSnapshot().sessionRef).toEqual(ref)
    expect(events.filter((event) => event.type === 'session_bound')).toEqual([
      { type: 'session_bound', ref },
    ])
  })

  it('does not inject YOLO plugins into the native Claude query', async () => {
    const { sdk, queryInputs } = createSdk()
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await runtime.ensureReady({})

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

    await expect(runtime.ensureReady({})).rejects.toThrow(
      'Claude authentication failed',
    )
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
    await runtime.ensureReady({})

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
    await runtime.ensureReady({})
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
      {
        questions: [
          {
            id: 'context',
            question: 'Anything else?',
            header: 'Context',
            options: [],
            multiSelect: false,
            isOther: true,
          },
          {
            id: 'approach',
            question: 'Which approach?',
            header: 'Approach',
            options: [
              { label: 'Simple', description: 'Use the direct path.' },
              { label: 'Layered', description: 'Add an abstraction.' },
            ],
            multiSelect: false,
          },
          {
            id: 'features',
            question: 'Which features?',
            header: 'Features',
            options: [
              { label: 'Fast', description: 'Optimize latency.' },
              { label: 'Safe', description: 'Add more checks.' },
            ],
            multiSelect: true,
          },
        ],
      },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-2',
        requestId: 'request-2',
      },
    )
    await flushPromises()
    await runtime.respondQuestion({
      requestId: 'request-2',
      answer: {
        type: 'user_answers',
        answers: [
          {
            id: 'context',
            question: 'Anything else?',
            inputType: 'free_text',
            value: 'Keep the API narrow.',
          },
          {
            id: 'approach',
            question: 'Which approach?',
            inputType: 'single_select',
            value: '__other__',
            otherText: 'Hybrid',
          },
          {
            id: 'features',
            question: 'Which features?',
            inputType: 'multi_select',
            value: ['Fast', '__other__'],
            otherText: 'Observable',
          },
        ],
      },
    })
    await expect(question).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: {
        answers: {
          context: 'Keep the API narrow.',
          approach: 'Hybrid',
          features: ['Fast', 'Observable'],
        },
      },
    })

    const pendingQuestionEvent = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === 'message_upsert' &&
          event.message.role === 'tool' &&
          event.message.toolCalls[0]?.request.id === 'tool-2' &&
          event.message.toolCalls[0].response.status ===
            ToolCallResponseStatus.AwaitingUserInput,
      )
    expect(pendingQuestionEvent).toMatchObject({
      type: 'message_upsert',
      message: {
        toolCalls: [
          {
            request: {
              name: 'yolo_local__ask_user_question',
              arguments: {
                kind: 'complete',
                value: {
                  questions: [
                    {
                      id: 'context',
                      prompt: 'Anything else?',
                      inputType: 'free_text',
                    },
                    {
                      id: 'approach',
                      prompt: 'Which approach?',
                      inputType: 'single_select',
                      options: [
                        { id: 'Simple', label: 'Simple' },
                        { id: 'Layered', label: 'Layered' },
                      ],
                    },
                    {
                      id: 'features',
                      prompt: 'Which features?',
                      inputType: 'multi_select',
                      options: [
                        { id: 'Fast', label: 'Fast' },
                        { id: 'Safe', label: 'Safe' },
                      ],
                    },
                  ],
                },
              },
            },
          },
        ],
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

  it('denies malformed nested AskUserQuestion answer payloads', async () => {
    const { sdk, queryInputs } = createSdk()
    const events: CliRuntimeEvent[] = []
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    runtime.subscribe((event) => events.push(event))
    await runtime.ensureReady({})
    const canUseTool = queryInputs[0].options?.canUseTool as CanUseTool
    const question = canUseTool(
      'AskUserQuestion',
      {
        questions: [
          {
            id: 'choice',
            question: 'Choose one?',
            options: [
              { label: 'A', description: 'Option A' },
              { label: 'B', description: 'Option B' },
            ],
            multiSelect: false,
          },
        ],
      },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-invalid-answer',
        requestId: 'request-invalid-answer',
      },
    )
    await flushPromises()
    await runtime.respondQuestion({
      requestId: 'request-invalid-answer',
      answer: { answers: { choice: 'A' } },
    })

    await expect(question).resolves.toMatchObject({
      behavior: 'deny',
      interrupt: true,
    })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message_upsert',
          message: expect.objectContaining({
            role: 'tool',
            toolCalls: [
              expect.objectContaining({
                response: expect.objectContaining({
                  status: ToolCallResponseStatus.Error,
                }),
              }),
            ],
          }),
        }),
      ]),
    )
  })

  it('interrupts without discarding the persistent query', async () => {
    const { sdk, query, queryInputs, queryInstance } = createSdk()
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    const readyInput = {}
    await runtime.ensureReady(readyInput)
    const sessionId = queryInputs[0].options?.sessionId
    if (!sessionId) throw new Error('Expected generated Claude session ID')
    const sessionRef = {
      runtimeId: 'claude-code' as const,
      nativeSessionId: sessionId,
    }
    await runtime.sendTurn({ content: 'Start' })
    await runtime.cancel()
    await runtime.ensureReady({ ...readyInput, sessionRef })
    await runtime.sendTurn({ sessionRef, content: 'Continue' })

    expect(queryInstance.interrupt).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
  })
})
