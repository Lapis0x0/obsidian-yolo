import type {
  CanUseTool,
  Options,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
} from '@yolo/claude-agent-sdk-runtime'
import { Platform } from 'obsidian'

import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { CliConversationController } from '../conversation-controller'
import type { CliRuntimeEvent } from '../types'

import { ClaudeCliRuntime } from './ClaudeCliRuntime'
import {
  hydrateClaudeSessionMessages,
  hydrateClaudeSessionTranscript,
} from './messages'
import type {
  ClaudeProcessSupport,
  ClaudeSdkModule,
  ClaudeSdkQuery,
} from './types'

type QueryInput = {
  prompt: AsyncIterable<SDKUserMessage> | string
  options?: Options
}

it('hydrates nested Claude tool calls with their native parent relationship', () => {
  const messages = hydrateClaudeSessionMessages([
    {
      type: 'assistant',
      uuid: 'nested-assistant',
      session_id: 'session-1',
      parent_tool_use_id: 'parent-tool',
      parent_agent_id: null,
      message: {
        id: 'nested-message',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'child-tool',
            name: 'Read',
            input: { file_path: '/vault/note.md' },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'nested-result',
      session_id: 'session-1',
      parent_tool_use_id: 'parent-tool',
      parent_agent_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'child-tool',
            content: 'note contents',
          },
        ],
      },
    },
  ] as SessionMessage[])

  expect(messages).toMatchObject([
    {
      role: 'assistant',
      metadata: { cliSubagentParentCallId: 'parent-tool' },
      toolCallRequests: [
        {
          name: 'Read',
          metadata: {
            cliToolCall: {
              runtimeId: 'claude-code',
              parentCallId: 'parent-tool',
            },
          },
        },
      ],
    },
    {
      role: 'tool',
      toolCalls: [
        {
          request: {
            name: 'Read',
            metadata: {
              cliToolCall: { parentCallId: 'parent-tool' },
            },
          },
          response: { data: { text: 'note contents' } },
        },
      ],
    },
  ])
})

it('hydrates async Agent completion notifications back into the dispatch call', () => {
  const messages = hydrateClaudeSessionMessages([
    {
      type: 'assistant',
      uuid: 'agent-request',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'agent-call',
            name: 'Agent',
            input: { description: 'Inspect runtime', prompt: 'Inspect it.' },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'agent-launched',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'agent-call',
            content: 'Async agent launched successfully.',
          },
        ],
      },
      toolUseResult: {
        status: 'async_launched',
        agentId: 'agent-1',
      },
    } as unknown as SessionMessage,
    {
      type: 'user',
      uuid: 'agent-completed',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        role: 'user',
        content:
          '<task-notification><task-id>agent-1</task-id><tool-use-id>agent-call</tool-use-id><status>completed</status><summary>Agent finished</summary><result>Review complete</result></task-notification>',
      },
    },
  ] as SessionMessage[])

  expect(messages).toHaveLength(2)
  expect(messages[1]).toMatchObject({
    role: 'tool',
    toolCalls: [
      {
        request: { id: 'agent-call', name: 'Agent' },
        response: {
          status: ToolCallResponseStatus.Success,
          data: {
            text: 'Review complete',
            metadata: {
              cliToolResult: {
                agentId: 'agent-1',
                status: 'completed',
              },
            },
          },
        },
      },
    ],
  })
})

it('hides Claude local command envelopes from restored chat history', () => {
  const messages = hydrateClaudeSessionMessages([
    {
      type: 'user',
      uuid: 'command-caveat',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        role: 'user',
        content:
          '<local-command-caveat>Generated while running a local command.</local-command-caveat>',
      },
    },
    {
      type: 'user',
      uuid: 'command-model',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        role: 'user',
        content:
          '<command-name>/model</command-name><command-message>model</command-message><command-args>haiku</command-args>',
      },
    },
    {
      type: 'user',
      uuid: 'command-output',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        role: 'user',
        content:
          '<local-command-stdout>Set model to haiku</local-command-stdout>',
      },
    },
    {
      type: 'user',
      uuid: 'real-user-message',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        role: 'user',
        content: '你现在是什么模式',
      },
    },
  ] as SessionMessage[])

  expect(messages).toEqual([
    expect.objectContaining({
      role: 'user',
      id: 'real-user-message',
      promptContent: '你现在是什么模式',
    }),
  ])
})

it('restores native compaction boundaries and hides their synthetic summaries', () => {
  const transcript = hydrateClaudeSessionTranscript([
    {
      type: 'assistant',
      uuid: 'assistant-before-compact',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Before compact' }],
      },
    },
    {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compact-1',
      compactMetadata: {
        trigger: 'manual',
        preTokens: 42_000,
        postTokens: 8_000,
        preservedSegment: { anchorUuid: 'summary-1' },
      },
    },
    {
      type: 'user',
      uuid: 'summary-1',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        role: 'user',
        content: 'This session is being continued from a previous summary.',
      },
    },
    {
      type: 'user',
      uuid: 'real-user',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: { role: 'user', content: 'Continue' },
    },
    {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compact-2',
      compactMetadata: { trigger: 'auto' },
    },
  ] as unknown as SessionMessage[])

  expect(transcript.messages.map((message) => message.id)).toEqual([
    'assistant-before-compact',
    'real-user',
  ])
  expect(transcript.compactionBoundaries).toEqual([
    {
      id: 'claude-compact-compact-1',
      afterMessageId: 'assistant-before-compact',
      trigger: 'manual',
      preTokens: 42_000,
      postTokens: 8_000,
    },
    {
      id: 'claude-compact-compact-2',
      afterMessageId: 'real-user',
      trigger: 'auto',
    },
  ])
})

class FakeQuery implements ClaudeSdkQuery {
  readonly interrupt = jest.fn(async () => undefined)
  readonly initializationResult = jest.fn<
    ReturnType<ClaudeSdkQuery['initializationResult']>,
    Parameters<ClaudeSdkQuery['initializationResult']>
  >(async () => ({
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
  readonly reloadSkills = jest.fn(async () => ({
    skills: [] as Array<{
      name: string
      description: string
      argumentHint?: string
    }>,
  }))
  readonly reloadPlugins = jest.fn(async (): Promise<unknown> => undefined)
  readonly mcpServerStatus = jest.fn<
    ReturnType<NonNullable<ClaudeSdkQuery['mcpServerStatus']>>,
    Parameters<NonNullable<ClaudeSdkQuery['mcpServerStatus']>>
  >(async () => [])
  readonly reconnectMcpServer = jest.fn(
    async (_serverName: string) => undefined,
  )
  readonly toggleMcpServer = jest.fn(
    async (_serverName: string, _enabled: boolean) => undefined,
  )
  readonly setModel = jest.fn(async () => undefined)
  readonly setPermissionMode = jest.fn(async () => undefined)
  readonly applyFlagSettings = jest.fn(async () => undefined)
  readonly getContextUsage = jest.fn<
    ReturnType<ClaudeSdkQuery['getContextUsage']>,
    Parameters<ClaudeSdkQuery['getContextUsage']>
  >(async () => ({
    categories: [],
    // Invalid total keeps tests that do not exercise detailed usage on the
    // result-derived fallback while preserving the SDK response shape.
    totalTokens: Number.NaN,
    maxTokens: 0,
    rawMaxTokens: 0,
    percentage: 0,
  }))
  readonly rewindFiles = jest.fn<
    ReturnType<ClaudeSdkQuery['rewindFiles']>,
    Parameters<ClaudeSdkQuery['rewindFiles']>
  >(async () => ({
    canRewind: true,
    filesChanged: [],
  }))
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
  const queryInstances = [queryInstance]
  const queryInputs: QueryInput[] = []
  const getSessionMessages = jest.fn<
    Promise<SessionMessage[]>,
    [sessionId: string, options?: { dir?: string }]
  >(async () => [])
  const getSubagentMessages = jest.fn<
    Promise<SessionMessage[]>,
    [sessionId: string, agentId: string, options?: { dir?: string }]
  >(async () => [])
  const query = jest.fn<ClaudeSdkQuery, [input: QueryInput]>((input) => {
    const instance =
      queryInstances[queryInputs.length] ??
      (() => {
        const created = new FakeQuery()
        queryInstances.push(created)
        return created
      })()
    queryInputs.push(input)
    return instance
  })
  const sdk: ClaudeSdkModule = {
    query,
    getSessionMessages,
    getSubagentMessages,
  }
  return {
    sdk,
    query,
    queryInputs,
    queryInstances,
    queryInstance,
    getSessionMessages,
    getSubagentMessages,
  }
}

const processSupport: ClaudeProcessSupport = {
  cliPath: '/opt/homebrew/bin/claude',
  nodePath: null,
  env: { PATH: '/opt/homebrew/bin:/usr/bin' },
  createAbortController: () => new AbortController(),
  spawnClaudeCodeProcess: jest.fn(),
}

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve()
  }
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

    await expect(
      runtime.openSession({
        runtimeId: 'claude-code',
        nativeSessionId: 'session-1',
      }),
    ).rejects.toThrow(/only available on desktop/)
    await expect(runtime.ensureReady({})).rejects.toThrow(
      /only available on desktop/,
    )
    expect(loadSdk).not.toHaveBeenCalled()
    expect(resolveProcessSupport).not.toHaveBeenCalled()
  })

  it('hydrates a known native session by its stable reference', async () => {
    const { sdk, getSessionMessages } = createSdk()
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

    const hydration = await runtime.openSession({
      runtimeId: 'claude-code',
      nativeSessionId: 'session-1',
    })

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
          metadata: {
            cliToolCall: {
              capability: 'command_execution',
            },
          },
        },
      ],
    })
    expect(hydration.messages[2]).toMatchObject({
      role: 'tool',
      toolCalls: [
        {
          request: {
            id: 'tool-1',
            name: 'Bash',
            metadata: {
              cliToolCall: {
                capability: 'command_execution',
              },
            },
          },
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
          name: 'AskUserQuestion',
          arguments: {
            kind: 'complete',
            value: {
              questions: [
                {
                  id: 'choice',
                  options: [
                    { label: 'A', description: 'Option A' },
                    { label: 'B', description: 'Option B' },
                  ],
                  question: 'Choose one?',
                  multiSelect: false,
                },
              ],
            },
          },
          metadata: {
            cliToolCall: {
              capability: 'user_question',
              presentationArguments: {
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
        },
      ],
    })
    expect(hydration.messages[4]).toMatchObject({
      role: 'tool',
      toolCalls: [
        {
          request: {
            id: 'question-tool',
            name: 'AskUserQuestion',
          },
        },
      ],
    })
  })

  it('rewrites from the previous native message into a replacement session', async () => {
    const { sdk, getSessionMessages, queryInputs, queryInstances } = createSdk()
    getSessionMessages.mockResolvedValue([
      {
        type: 'user',
        uuid: 'user-1',
        session_id: 'session-1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'user', content: 'first' },
      },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: 'session-1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'assistant', content: 'answer' },
      },
      {
        type: 'assistant',
        uuid: 'compact-summary-1',
        session_id: 'session-1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'assistant', content: 'compacted context summary' },
      },
      {
        type: 'user',
        uuid: 'user-2',
        session_id: 'session-1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'user', content: 'second' },
      },
    ])
    const events: CliRuntimeEvent[] = []
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    runtime.subscribe((event) => events.push(event))
    await runtime.ensureReady({
      sessionRef: {
        runtimeId: 'claude-code',
        nativeSessionId: 'session-1',
      },
    })

    await runtime.rewriteTurn({
      sessionRef: {
        runtimeId: 'claude-code',
        nativeSessionId: 'session-1',
      },
      sourceUserMessageId: 'user-2',
      userMessageId: 'user-2',
      content: 'edited second',
    })

    expect(queryInputs[1]?.options).toMatchObject({
      resume: 'session-1',
      resumeSessionAt: 'compact-summary-1',
      forkSession: true,
      enableFileCheckpointing: true,
    })
    expect(queryInputs[1]?.options?.sessionId).not.toBe('session-1')
    expect(queryInstances).toHaveLength(2)
    expect(
      events.filter((event) => event.type === 'session_bound').at(-1),
    ).toMatchObject({
      type: 'session_bound',
      ref: { runtimeId: 'claude-code' },
    })
  })

  it('publishes a shared edit summary from Claude file checkpoints', async () => {
    const { sdk, queryInstance } = createSdk()
    queryInstance.rewindFiles.mockResolvedValue({
      canRewind: true,
      filesChanged: ['/vault/src/a.ts', '/vault/src/b.ts'],
      insertions: 7,
      deletions: 2,
    })
    const events: CliRuntimeEvent[] = []
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    runtime.subscribe((event) => events.push(event))
    await runtime.ensureReady({})
    await runtime.sendTurn({ userMessageId: 'user-1', content: 'edit files' })
    queryInstance.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
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

    expect(queryInstance.rewindFiles).toHaveBeenCalledWith('user-1', {
      dryRun: true,
    })
    expect(events).toContainEqual({
      type: 'turn_edit_summary',
      sourceUserMessageId: 'user-1',
      summary: expect.objectContaining({
        totalFiles: 2,
        totalAddedLines: 7,
        totalRemovedLines: 2,
        files: [
          expect.objectContaining({ path: 'src/a.ts' }),
          expect.objectContaining({ path: 'src/b.ts' }),
        ],
      }),
    })
  })

  it('emits context_usage from Claude result usage and modelUsage', async () => {
    const { sdk, queryInstance } = createSdk()
    const events: CliRuntimeEvent[] = []
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    runtime.subscribe((event) => events.push(event))
    await runtime.ensureReady({})
    await runtime.sendTurn({ content: 'hello' })
    queryInstance.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'hi',
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 20,
        server_tool_use: null,
        service_tier: 'standard',
      },
      modelUsage: {
        'claude-sonnet': { contextWindow: 200_000 },
      },
      permission_denials: [],
      uuid: 'result-usage',
      session_id: 'session-1',
    } as unknown as SDKMessage)
    await flushPromises()

    expect(events).toContainEqual({
      type: 'context_usage',
      usage: {
        promptTokens: 125,
        maxContextTokens: 200_000,
        cacheHitRate: 0.16,
      },
    })
  })

  it('prefers getContextUsage categories when available', async () => {
    const { sdk, queryInstance } = createSdk()
    queryInstance.getContextUsage.mockResolvedValue({
      categories: [
        { name: 'System prompt', tokens: 345, color: '#888888' },
        { name: 'Tools', tokens: 4700, color: '#4C6EF5' },
        { name: 'Messages', tokens: 288, color: '#74C0FC' },
      ],
      totalTokens: 5333,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 3,
    })
    const events: CliRuntimeEvent[] = []
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    runtime.subscribe((event) => events.push(event))
    await runtime.ensureReady({})
    await runtime.sendTurn({ content: 'hello' })
    queryInstance.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'hi',
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: 'standard',
      },
      modelUsage: {
        'claude-sonnet': { contextWindow: 200_000 },
      },
      permission_denials: [],
      uuid: 'result-usage-detailed',
      session_id: 'session-1',
    } as unknown as SDKMessage)
    await flushPromises()

    expect(queryInstance.getContextUsage).toHaveBeenCalled()
    expect(events).toContainEqual({
      type: 'context_usage',
      usage: {
        promptTokens: 5333,
        maxContextTokens: 200_000,
        cacheHitRate: 0,
        categories: [
          { name: 'System prompt', tokens: 345, bucket: 'system' },
          { name: 'Tools', tokens: 4700, bucket: 'tools' },
          { name: 'Messages', tokens: 288, bucket: 'conversation' },
        ],
      },
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

  it('lists native skills and routes manual compaction through Claude Code', async () => {
    const { sdk, queryInputs, queryInstance } = createSdk()
    queryInstance.reloadSkills.mockResolvedValue({
      skills: [
        {
          name: 'review',
          description: 'Review the current change',
          argumentHint: '',
        },
      ],
    })
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    const events: CliRuntimeEvent[] = []
    runtime.subscribe((event) => events.push(event))

    await runtime.ensureReady({})
    await expect(runtime.listSkills()).resolves.toEqual([
      {
        name: 'review',
        description: 'Review the current change',
        path: 'claude-code://skills/review',
      },
    ])

    await runtime.compact()
    const prompt = queryInputs[0].prompt
    if (typeof prompt === 'string') throw new Error('Expected streaming prompt')
    await expect(prompt[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { type: 'user', message: { content: '/compact' } },
    })
    expect(events).not.toContainEqual({ type: 'run_state', state: 'running' })
  })

  it('reloadPlugins forwards to the SDK query when supported', async () => {
    const { sdk, queryInstance } = createSdk()
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await runtime.ensureReady({})
    await runtime.reloadPlugins()

    expect(queryInstance.reloadPlugins).toHaveBeenCalledTimes(1)
  })

  it('reloadPlugins no-ops when the SDK query predates it', async () => {
    const { sdk, queryInstance } = createSdk()
    delete (queryInstance as unknown as { reloadPlugins?: unknown })
      .reloadPlugins
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await runtime.ensureReady({})

    await expect(runtime.reloadPlugins()).resolves.toBeUndefined()
  })

  it('mcpServerStatus maps the SDK query response to CliRuntimeMcpServerStatus', async () => {
    const { sdk, queryInstance } = createSdk()
    queryInstance.mcpServerStatus.mockResolvedValue([
      {
        name: 'github',
        status: 'connected',
        scope: 'user',
        tools: [{ name: 'get_commit' }, { name: 'list_prs' }],
      },
      {
        name: 'broken',
        status: 'failed',
        error: 'connection refused',
      },
      {
        // Simulates an SDK build reporting a status value this adapter does
        // not yet recognize.
        name: 'future',
        status: 'future-status',
      } as unknown as Awaited<
        ReturnType<NonNullable<ClaudeSdkQuery['mcpServerStatus']>>
      >[number],
    ])
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await runtime.ensureReady({})

    await expect(runtime.mcpServerStatus()).resolves.toEqual([
      {
        name: 'github',
        status: 'connected',
        scope: 'user',
        toolCount: 2,
        readOnly: false,
      },
      {
        name: 'broken',
        status: 'failed',
        errorMessage: 'connection refused',
        readOnly: false,
      },
      {
        name: 'future',
        status: 'unknown',
        readOnly: false,
      },
    ])
  })

  it('mcpServerStatus returns an empty list when the SDK query predates it', async () => {
    const { sdk, queryInstance } = createSdk()
    delete (queryInstance as unknown as { mcpServerStatus?: unknown })
      .mcpServerStatus
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await runtime.ensureReady({})

    await expect(runtime.mcpServerStatus()).resolves.toEqual([])
  })

  it('mcpServerStatus throws when the runtime is not ready', async () => {
    const { sdk } = createSdk()
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await expect(runtime.mcpServerStatus()).rejects.toThrow(
      'Claude CLI runtime is not ready.',
    )
  })

  it('toggleMcpServer forwards to the SDK query when supported', async () => {
    const { sdk, queryInstance } = createSdk()
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await runtime.ensureReady({})
    await runtime.toggleMcpServer('github', false)

    expect(queryInstance.toggleMcpServer).toHaveBeenCalledWith('github', false)
  })

  it('toggleMcpServer throws when the SDK query predates it', async () => {
    const { sdk, queryInstance } = createSdk()
    delete (queryInstance as unknown as { toggleMcpServer?: unknown })
      .toggleMcpServer
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await runtime.ensureReady({})

    await expect(runtime.toggleMcpServer('github', true)).rejects.toThrow(
      'does not support toggling MCP servers',
    )
  })

  it('reconnectMcpServer forwards to the SDK query when supported', async () => {
    const { sdk, queryInstance } = createSdk()
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await runtime.ensureReady({})
    await runtime.reconnectMcpServer('github')

    expect(queryInstance.reconnectMcpServer).toHaveBeenCalledWith('github')
  })

  it('reconnectMcpServer throws when the SDK query predates it', async () => {
    const { sdk, queryInstance } = createSdk()
    delete (queryInstance as unknown as { reconnectMcpServer?: unknown })
      .reconnectMcpServer
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await runtime.ensureReady({})

    await expect(runtime.reconnectMcpServer('github')).rejects.toThrow(
      'does not support reconnecting MCP servers',
    )
  })

  it('maps Claude compact boundaries to native compaction markers', async () => {
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
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      uuid: '00000000-0000-4000-8000-000000000000',
      session_id: 'session-1',
    } as SDKMessage)
    await flushPromises()
    expect(events.at(-1)).toEqual({
      type: 'compaction_state',
      isCompacting: true,
    })

    queryInstance.push({
      type: 'system',
      subtype: 'compact_boundary',
      uuid: '00000000-0000-4000-8000-000000000001',
      session_id: 'session-1',
      compact_metadata: {
        trigger: 'manual',
        pre_tokens: 120_000,
        post_tokens: 20_000,
      },
    } as SDKMessage)
    await flushPromises()

    expect(events).toContainEqual({
      type: 'compaction_state',
      isCompacting: false,
    })
    expect(events).toContainEqual({
      type: 'compaction_boundary',
      boundary: expect.objectContaining({
        id: 'claude-compact-00000000-0000-4000-8000-000000000001',
        trigger: 'manual',
        preTokens: 120_000,
        postTokens: 20_000,
      }),
    })
  })

  it('emits current context usage immediately after resuming a session', async () => {
    const { sdk, queryInstance } = createSdk()
    queryInstance.getContextUsage.mockResolvedValue({
      categories: [
        { name: 'System prompt', tokens: 4000, color: '#888888' },
        { name: 'Messages', tokens: 8000, color: '#74C0FC' },
      ],
      totalTokens: 12_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 6,
    })
    const events: CliRuntimeEvent[] = []
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    runtime.subscribe((event) => events.push(event))

    await runtime.ensureReady({
      sessionRef: {
        runtimeId: 'claude-code',
        nativeSessionId: 'restored-session',
      },
    })
    await flushPromises()

    expect(events).toContainEqual({
      type: 'context_usage',
      usage: {
        promptTokens: 12_000,
        maxContextTokens: 200_000,
        categories: [
          { name: 'System prompt', tokens: 4000, bucket: 'system' },
          { name: 'Messages', tokens: 8000, bucket: 'conversation' },
        ],
      },
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

  it('uses the native default alias when it resolves to the active model', async () => {
    const { sdk, queryInstance } = createSdk()
    queryInstance.initializationResult.mockResolvedValueOnce({
      commands: [],
      agents: [],
      output_style: '',
      available_output_styles: [],
      models: [
        {
          value: 'default',
          resolvedModel: 'claude-custom-sonnet',
          displayName: 'Default',
          description: '',
        },
      ],
      account: {
        email: '',
        organization: '',
        subscriptionType: '',
        tokenSource: 'none' as const,
      },
    })
    queryInstance.push({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session',
      model: 'claude-custom-sonnet',
    } as SDKMessage)
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await runtime.ensureReady({})
    await expect(runtime.getConfiguration()).resolves.toMatchObject({
      modelId: 'default',
      models: [
        {
          id: 'default',
          label: 'claude-custom-sonnet',
          isDefault: true,
        },
      ],
    })
    await runtime.dispose()
  })

  it('keeps the active Claude model when the native picker omits it', async () => {
    const { sdk, queryInstance } = createSdk()
    queryInstance.push({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session',
      model: 'claude-third-party-model',
    } as SDKMessage)
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await runtime.ensureReady({})
    await expect(runtime.getConfiguration()).resolves.toEqual({
      modelId: 'claude-third-party-model',
      reasoningEffort: null,
      models: [
        {
          id: 'claude-third-party-model',
          label: 'claude-third-party-model',
          reasoningEfforts: [],
        },
      ],
    })
    await runtime.dispose()
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
              name: 'AskUserQuestion',
              arguments: {
                kind: 'complete',
                value: {
                  questions: [
                    {
                      id: 'context',
                      question: 'Anything else?',
                    },
                    {
                      id: 'approach',
                      question: 'Which approach?',
                      options: [{ label: 'Simple' }, { label: 'Layered' }],
                    },
                    {
                      id: 'features',
                      question: 'Which features?',
                      multiSelect: true,
                      options: [{ label: 'Fast' }, { label: 'Safe' }],
                    },
                  ],
                },
              },
              metadata: {
                cliToolCall: {
                  capability: 'user_question',
                  presentationArguments: {
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

  it('starts sessions with acceptEdits by default', async () => {
    const { sdk, queryInputs } = createSdk()
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await runtime.ensureReady({})

    expect(queryInputs[0].options).toMatchObject({
      permissionMode: 'acceptEdits',
      allowDangerouslySkipPermissions: true,
    })
  })

  it('maps plan and yolo options into Claude permissionMode at start', async () => {
    const planSdk = createSdk()
    const planRuntime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => planSdk.sdk,
      resolveProcessSupport: async () => processSupport,
      cliChatMode: 'plan',
    })
    await planRuntime.ensureReady({})
    expect(planSdk.queryInputs[0].options?.permissionMode).toBe('plan')

    const yoloSdk = createSdk()
    const yoloRuntime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => yoloSdk.sdk,
      resolveProcessSupport: async () => processSupport,
      cliChatMode: 'agent',
      yoloEnabled: true,
    })
    await yoloRuntime.ensureReady({})
    expect(yoloSdk.queryInputs[0].options?.permissionMode).toBe(
      'bypassPermissions',
    )
  })

  it('hot-updates permission mode via setPermissionMode', async () => {
    const { sdk, queryInputs, queryInstance } = createSdk()
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })
    await runtime.ensureReady({})
    expect(queryInputs[0].options?.permissionMode).toBe('acceptEdits')

    await runtime.updatePermissionProfile({
      mode: 'plan',
      yoloEnabled: false,
    })
    expect(queryInstance.setPermissionMode).toHaveBeenCalledWith('plan')

    await runtime.updatePermissionProfile({
      mode: 'agent',
      yoloEnabled: true,
    })
    expect(queryInstance.setPermissionMode).toHaveBeenCalledWith(
      'bypassPermissions',
    )

    await runtime.updatePermissionProfile({
      mode: 'agent',
      yoloEnabled: false,
    })
    expect(queryInstance.setPermissionMode).toHaveBeenCalledWith('acceptEdits')
  })

  it('stores permission profile before ready and applies it on startSession', async () => {
    const { sdk, queryInputs } = createSdk()
    const runtime = new ClaudeCliRuntime({
      vaultPath: '/vault',
      loadSdk: async () => sdk,
      resolveProcessSupport: async () => processSupport,
    })

    await runtime.updatePermissionProfile({
      mode: 'plan',
      yoloEnabled: true,
    })
    await runtime.ensureReady({})

    expect(queryInputs[0].options?.permissionMode).toBe('plan')
  })
})
