import { ChatMessage, ChatUserMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { backgroundTaskCompletionBus } from './background-task/completion-bus'
import { AgentService } from './service'
import { subagentRuntimeRegistry } from './subagent/runtime-registry'
import { subagentTaskRegistry } from './subagent/task-registry'
import type { SubagentTaskRecord } from './subagent/types'
import { AgentRuntimeRunInput } from './types'

type MockRuntimeInstance = {
  abort: jest.Mock
  run: jest.Mock<Promise<void>, [AgentRuntimeRunInput]>
  subscribe: jest.Mock<
    () => void,
    [(snapshot: { messages: ChatMessage[] }) => void]
  >
  emitSnapshot: (messages: ChatMessage[]) => void
  resolveRun: () => void
  rejectRun: (error: Error) => void
  getRunInput: () => AgentRuntimeRunInput | null
}

type AgentServiceInternals = {
  conversationEntries: Map<string, unknown>
  runEntriesByKey: Map<string, unknown>
  foregroundToolAbortersByConversation: Map<string, unknown>
  persistTimers: Map<string, unknown>
  pendingScheduledConversationPublishes: Map<
    string,
    { rafId: number | null; timeoutId: ReturnType<typeof setTimeout> }
  >
  pendingBackgroundTaskResults: Map<string, unknown>
  autoRunScheduled: Set<string>
  pendingUserMessagesByKey: Map<string, unknown>
  continuationScheduledByKey: Set<string>
}

const getAgentServiceInternals = (
  service: AgentService,
): AgentServiceInternals => service as unknown as AgentServiceInternals

const runtimeInstances: MockRuntimeInstance[] = []

jest.mock('./native-runtime', () => ({
  NativeAgentRuntime: jest.fn().mockImplementation(() => {
    let subscriber:
      | ((snapshot: {
          messages: ChatMessage[]
          compaction: []
          pendingCompactionAnchorMessageId: null
        }) => void)
      | null = null
    let resolveRun: (() => void) | null = null
    let rejectRun: ((error: Error) => void) | null = null
    let capturedInput: AgentRuntimeRunInput | null = null
    const runPromise = new Promise<void>((resolve, reject) => {
      resolveRun = resolve
      rejectRun = reject
    })

    const instance: MockRuntimeInstance = {
      abort: jest.fn(),
      run: jest.fn((input: AgentRuntimeRunInput) => {
        capturedInput = input
        return runPromise
      }),
      subscribe: jest.fn((callback) => {
        subscriber = callback
        return () => {
          subscriber = null
        }
      }),
      emitSnapshot: (messages) => {
        subscriber?.({
          messages,
          compaction: [],
          pendingCompactionAnchorMessageId: null,
        })
      },
      resolveRun: () => {
        resolveRun?.()
      },
      rejectRun: (error: Error) => {
        rejectRun?.(error)
      },
      getRunInput: () => capturedInput,
    }

    runtimeInstances.push(instance)
    return instance
  }),
}))

const createStreamingMessages = (): ChatMessage[] => [
  {
    role: 'user',
    id: 'user-1',
    content: null,
    promptContent: 'hello',
    mentionables: [],
  },
  {
    role: 'assistant',
    id: 'assistant-1',
    content: '',
    metadata: {
      generationState: 'streaming',
    },
  },
  {
    role: 'tool',
    id: 'tool-1',
    toolCalls: [
      {
        request: {
          id: 'tool-call-1',
          name: 'local:fs_read',
        },
        response: {
          status: ToolCallResponseStatus.Running,
        },
      },
      {
        request: {
          id: 'tool-call-2',
          name: 'local:fs_write',
        },
        response: {
          status: ToolCallResponseStatus.PendingApproval,
        },
      },
    ],
  },
]

describe('AgentService abort handling', () => {
  beforeEach(() => {
    runtimeInstances.length = 0
  })

  it('marks streaming assistant and active tool calls as aborted immediately', async () => {
    const service = new AgentService()
    const abortController = new AbortController()

    const runPromise = service.run({
      conversationId: 'conversation-1',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: {
        conversationId: 'conversation-1',
        messages: [createStreamingMessages()[0]],
        abortSignal: abortController.signal,
      } as never,
    })

    const runtime = runtimeInstances[0]
    runtime.emitSnapshot(createStreamingMessages())

    abortController.abort()
    expect(service.abortConversation('conversation-1')).toBe(true)

    const state = service.getState('conversation-1')
    const assistantMessage = state.messages.find(
      (message) => message.role === 'assistant',
    )
    const toolMessage = state.messages.find(
      (message) => message.role === 'tool',
    )

    expect(runtime.abort).toHaveBeenCalledTimes(1)
    expect(state.status).toBe('aborted')
    expect(assistantMessage).toMatchObject({
      role: 'assistant',
      metadata: {
        generationState: 'aborted',
      },
    })
    expect(toolMessage).toMatchObject({
      role: 'tool',
      toolCalls: [
        { response: { status: ToolCallResponseStatus.Aborted } },
        { response: { status: ToolCallResponseStatus.Aborted } },
      ],
    })

    runtime.resolveRun()
    await runPromise
  })

  it('preserves aborted state when a late snapshot still reports streaming', async () => {
    const service = new AgentService()
    const abortController = new AbortController()

    const runPromise = service.run({
      conversationId: 'conversation-2',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: {
        conversationId: 'conversation-2',
        messages: [createStreamingMessages()[0]],
        abortSignal: abortController.signal,
      } as never,
    })

    const runtime = runtimeInstances[0]
    runtime.emitSnapshot(createStreamingMessages())

    abortController.abort()
    service.abortConversation('conversation-2')
    runtime.emitSnapshot(createStreamingMessages())

    const state = service.getState('conversation-2')
    const assistantMessage = state.messages.find(
      (message) => message.role === 'assistant',
    )
    const toolMessage = state.messages.find(
      (message) => message.role === 'tool',
    )

    expect(assistantMessage).toMatchObject({
      role: 'assistant',
      metadata: {
        generationState: 'aborted',
      },
    })
    expect(toolMessage).toMatchObject({
      role: 'tool',
      toolCalls: [
        { response: { status: ToolCallResponseStatus.Aborted } },
        { response: { status: ToolCallResponseStatus.Aborted } },
      ],
    })

    runtime.resolveRun()
    await runPromise
  })

  it('keeps the existing branch in place while a branch retry is starting', async () => {
    const service = new AgentService()
    const userMessage: ChatMessage = {
      role: 'user',
      id: 'user-1',
      content: null,
      promptContent: 'hello',
      mentionables: [],
    }
    const branchAResponse: ChatMessage = {
      role: 'assistant',
      id: 'assistant-a',
      content: 'branch a',
      metadata: {
        generationState: 'completed',
        sourceUserMessageId: 'user-1',
        branchId: 'branch-a',
      },
    }
    const branchBResponse: ChatMessage = {
      role: 'assistant',
      id: 'assistant-b-old',
      content: 'branch b old',
      metadata: {
        generationState: 'completed',
        sourceUserMessageId: 'user-1',
        branchId: 'branch-b',
      },
    }

    service.replaceConversationMessages('conversation-3', [
      userMessage,
      branchAResponse,
      branchBResponse,
    ])

    const runPromise = service.run({
      conversationId: 'conversation-3',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: {
        conversationId: 'conversation-3',
        branchId: 'branch-b',
        sourceUserMessageId: 'user-1',
        messages: [userMessage],
        requestMessages: [userMessage],
      } as never,
    })

    expect(service.getState('conversation-3').messages).toEqual([
      userMessage,
      branchAResponse,
      {
        ...branchBResponse,
        metadata: {
          ...branchBResponse.metadata,
          branchRunStatus: 'running',
          branchWaitingApproval: false,
        },
      },
    ])

    const runtime = runtimeInstances[0]
    runtime.emitSnapshot([
      {
        role: 'assistant',
        id: 'assistant-b-new',
        content: 'branch b new',
        metadata: {
          generationState: 'streaming',
          sourceUserMessageId: 'user-1',
          branchId: 'branch-b',
        },
      },
    ])

    expect(service.getState('conversation-3').messages).toEqual([
      userMessage,
      branchAResponse,
      {
        role: 'assistant',
        id: 'assistant-b-new',
        content: 'branch b new',
        metadata: {
          generationState: 'streaming',
          sourceUserMessageId: 'user-1',
          branchId: 'branch-b',
        },
      },
    ])

    runtime.resolveRun()
    await runPromise
  })

  it('aborting a single tool call keeps the run alive (issue #338)', async () => {
    const service = new AgentService()
    const mcpAbortToolCall = jest.fn()

    const runPromise = service.run({
      conversationId: 'conversation-parallel',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: {
        conversationId: 'conversation-parallel',
        messages: [createStreamingMessages()[0]],
        mcpManager: { abortToolCall: mcpAbortToolCall },
      } as never,
    })

    const runtime = runtimeInstances[0]
    runtime.emitSnapshot([
      createStreamingMessages()[0],
      {
        role: 'assistant',
        id: 'assistant-1',
        content: '',
        metadata: { generationState: 'streaming' },
      },
      {
        role: 'tool',
        id: 'tool-1',
        toolCalls: [
          {
            request: { id: 'tool-call-1', name: 'local:fs_read' },
            response: { status: ToolCallResponseStatus.Running },
          },
          {
            request: { id: 'tool-call-2', name: 'local:fs_read' },
            response: { status: ToolCallResponseStatus.Running },
          },
        ],
      },
    ])

    expect(
      service.abortToolCall({
        conversationId: 'conversation-parallel',
        toolCallId: 'tool-call-1',
      }),
    ).toBe(true)

    expect(mcpAbortToolCall).toHaveBeenCalledWith('tool-call-1')
    expect(runtime.abort).not.toHaveBeenCalled()

    const state = service.getState('conversation-parallel')
    expect(state.status).toBe('running')

    const toolMessage = state.messages.find(
      (message) => message.role === 'tool',
    )
    expect(toolMessage).toMatchObject({
      role: 'tool',
      toolCalls: [
        { response: { status: ToolCallResponseStatus.Aborted } },
        { response: { status: ToolCallResponseStatus.Running } },
      ],
    })

    runtime.resolveRun()
    await runPromise
  })
})

describe('AgentService streaming publish coalescing', () => {
  const makeStreamingAssistantMessage = (
    content: string,
    options?: Partial<Extract<ChatMessage, { role: 'assistant' }>>,
  ): ChatMessage => ({
    role: 'assistant',
    id: 'assistant-streaming',
    content,
    reasoning: options?.reasoning,
    metadata: {
      generationState: 'streaming',
      ...options?.metadata,
    },
    toolCallRequests: options?.toolCallRequests,
    annotations: options?.annotations,
  })

  beforeEach(() => {
    runtimeInstances.length = 0
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  it('coalesces streaming assistant display updates into one bounded frame publish', async () => {
    const service = new AgentService()
    const publishedStates: ChatMessage[][] = []
    service.subscribe(
      'conv-streaming-publish',
      (state) => {
        publishedStates.push(state.messages)
      },
      { emitCurrent: false },
    )

    const userMessage = makeUserMessage('u1', 'hello')
    const runPromise = service.run({
      conversationId: 'conv-streaming-publish',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-streaming-publish', [userMessage]),
    })
    const runtime = runtimeInstances[0]

    const assistantMessage = makeStreamingAssistantMessage('a') as Extract<
      ChatMessage,
      { role: 'assistant' }
    >
    runtime.emitSnapshot([userMessage, assistantMessage])
    expect(publishedStates).toHaveLength(2)
    const firstPublishedAssistant = publishedStates.at(-1)?.at(-1)

    assistantMessage.content = 'ab'
    runtime.emitSnapshot([userMessage, assistantMessage])
    assistantMessage.content = 'abc'
    runtime.emitSnapshot([userMessage, assistantMessage])
    expect(publishedStates).toHaveLength(2)
    expect(firstPublishedAssistant).toMatchObject({
      role: 'assistant',
      content: 'a',
    })

    jest.advanceTimersByTime(16)

    expect(publishedStates).toHaveLength(3)
    expect(publishedStates.at(-1)?.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'abc',
    })

    runtime.resolveRun()
    await runPromise
  })

  it('publishes tool call request changes immediately and cancels pending streaming publish', async () => {
    const service = new AgentService()
    const subscriber = jest.fn()
    service.subscribe('conv-tool-request-publish', subscriber, {
      emitCurrent: false,
    })

    const userMessage = makeUserMessage('u1', 'hello')
    const runPromise = service.run({
      conversationId: 'conv-tool-request-publish',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-tool-request-publish', [userMessage]),
    })
    const runtime = runtimeInstances[0]

    const assistantMessage = makeStreamingAssistantMessage('a') as Extract<
      ChatMessage,
      { role: 'assistant' }
    >
    runtime.emitSnapshot([userMessage, assistantMessage])
    expect(subscriber).toHaveBeenCalledTimes(2)

    assistantMessage.content = 'ab'
    runtime.emitSnapshot([userMessage, assistantMessage])
    expect(subscriber).toHaveBeenCalledTimes(2)

    assistantMessage.toolCallRequests = [
      {
        id: 'call-1',
        name: 'local:fs_read',
        arguments: { kind: 'complete', value: {} },
      },
    ]
    runtime.emitSnapshot([userMessage, assistantMessage])
    expect(subscriber).toHaveBeenCalledTimes(3)

    jest.advanceTimersByTime(16)
    expect(subscriber).toHaveBeenCalledTimes(3)

    runtime.resolveRun()
    await runPromise
  })

  it('publishes completion immediately and cancels pending streaming publish', async () => {
    const service = new AgentService()
    const subscriber = jest.fn()
    service.subscribe('conv-complete-publish', subscriber, {
      emitCurrent: false,
    })

    const userMessage = makeUserMessage('u1', 'hello')
    const runPromise = service.run({
      conversationId: 'conv-complete-publish',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-complete-publish', [userMessage]),
    })
    const runtime = runtimeInstances[0]

    runtime.emitSnapshot([userMessage, makeStreamingAssistantMessage('a')])
    runtime.emitSnapshot([userMessage, makeStreamingAssistantMessage('ab')])
    expect(subscriber).toHaveBeenCalledTimes(2)

    runtime.resolveRun()
    await runPromise

    const callsAfterCompletion = subscriber.mock.calls.length
    expect(callsAfterCompletion).toBeGreaterThanOrEqual(3)

    jest.advanceTimersByTime(16)
    expect(subscriber).toHaveBeenCalledTimes(callsAfterCompletion)
  })

  it('publishes abort immediately and cancels pending streaming publish', async () => {
    const service = new AgentService()
    const subscriber = jest.fn()
    service.subscribe('conv-abort-publish', subscriber, { emitCurrent: false })

    const userMessage = makeUserMessage('u1', 'hello')
    const runPromise = service.run({
      conversationId: 'conv-abort-publish',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-abort-publish', [userMessage]),
    })
    const runtime = runtimeInstances[0]
    const assistantMessage = makeStreamingAssistantMessage('a') as Extract<
      ChatMessage,
      { role: 'assistant' }
    >

    runtime.emitSnapshot([userMessage, assistantMessage])
    assistantMessage.content = 'ab'
    runtime.emitSnapshot([userMessage, assistantMessage])
    expect(subscriber).toHaveBeenCalledTimes(2)

    expect(service.abortConversation('conv-abort-publish')).toBe(true)
    expect(subscriber).toHaveBeenCalledTimes(3)
    expect(subscriber.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'aborted',
    })

    jest.advanceTimersByTime(16)
    expect(subscriber).toHaveBeenCalledTimes(3)

    runtime.resolveRun()
    await runPromise
  })
})

const makeUserMessage = (id: string, text: string): ChatUserMessage => ({
  role: 'user',
  id,
  content: null,
  promptContent: text,
  mentionables: [],
})

const buildBaseRunInput = (
  conversationId: string,
  messages: ChatMessage[],
): AgentRuntimeRunInput =>
  ({
    conversationId,
    messages,
  }) as unknown as AgentRuntimeRunInput

const makeToolMessage = (
  status:
    | ToolCallResponseStatus.PendingApproval
    | ToolCallResponseStatus.Running
    | ToolCallResponseStatus.AwaitingUserInput,
  toolCallId = 'tool-call-1',
): ChatMessage => ({
  role: 'tool',
  id: 'tool-1',
  toolCalls: [
    {
      request: { id: toolCallId, name: 'local:fs_read' },
      response: { status },
    },
  ],
})

const makeRunningTerminalResultMessage = (): ChatMessage => ({
  role: 'terminal_command_result',
  id: 'terminal-result-1',
  taskId: 'term-1',
  source: {
    type: 'llm_tool_call',
    toolCallId: 'terminal-call-1',
    assistantMessageId: 'assistant-1',
  },
  title: 'npm run dev',
  status: 'running',
  exitCode: null,
  stdout: '',
  stderr: '',
  durationMs: 1000,
  delegateAssistantMessageId: 'assistant-1',
  delegateToolCallId: 'terminal-call-1',
})

const makeCompletedSubagentResultMessage = (): ChatMessage => ({
  role: 'subagent_result',
  id: 'subagent-result-1',
  taskId: 'sub-1',
  source: {
    type: 'llm_tool_call',
    toolCallId: 'subagent-call-1',
    assistantMessageId: 'assistant-1',
  },
  title: 'Investigate issue',
  status: 'completed',
  content: 'done',
  durationMs: 1000,
  toolUseCount: 0,
  delegateAssistantMessageId: 'assistant-1',
  delegateToolCallId: 'subagent-call-1',
})

const makeFailedSubagentTaskRecord = (): SubagentTaskRecord => {
  const liveTranscript: ChatMessage[] = [
    {
      role: 'assistant',
      id: 'subagent-assistant-1',
      content: 'partial investigation before failure',
    },
  ]

  return {
    taskId: 'sub_failed_transcript_fallback',
    conversationId: 'conv-subagent-failed',
    source: {
      type: 'llm_tool_call',
      toolCallId: 'subagent-call-failed',
      assistantMessageId: 'assistant-1',
    },
    title: 'Investigate failure',
    status: 'failed',
    createdAt: 1,
    completedAt: 2,
    prompt: 'Investigate failure',
    liveTranscript,
    activityLog: '[error] failed',
    abortController: new AbortController(),
    result: {
      taskId: 'sub_failed_transcript_fallback',
      status: 'failed',
      content: 'failed',
      activityLog: '[error] failed',
      durationMs: 1,
      toolUseCount: 0,
      prompt: 'Investigate failure',
      modelName: 'test-model',
    },
  }
}

describe('AgentService dropConversation', () => {
  beforeEach(() => {
    runtimeInstances.length = 0
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  it('drops in-memory conversation state without persisting a deleted empty state', () => {
    const persistConversationMessages = jest.fn().mockResolvedValue(undefined)
    const service = new AgentService({ persistConversationMessages })
    const internals = getAgentServiceInternals(service)
    const subscriber = jest.fn()
    const stateFeedSubscriber = jest.fn()
    const foregroundAbort = jest.fn()

    service.subscribe('conv-drop', subscriber, { emitCurrent: false })
    service.subscribeToConversationStates(stateFeedSubscriber, {
      emitCurrent: false,
    })
    service.replaceConversationMessages('conv-drop', [
      makeUserMessage('u1', 'hi'),
    ])
    service.registerForegroundToolAborter({
      conversationId: 'conv-drop',
      toolCallId: 'tool-call-1',
      abort: foregroundAbort,
    })

    internals.pendingScheduledConversationPublishes.set('conv-drop', {
      rafId: null,
      timeoutId: setTimeout(() => undefined, 100),
    })
    internals.autoRunScheduled.add('conv-drop')
    internals.pendingBackgroundTaskResults.set('conv-drop', [])
    internals.pendingUserMessagesByKey.set('conv-drop::default', [
      makeUserMessage('queued-1', 'queued'),
    ])
    internals.continuationScheduledByKey.add('conv-drop::default')

    service.dropConversation('conv-drop')
    service.dropConversation('conv-drop')

    expect(foregroundAbort).toHaveBeenCalledTimes(1)
    expect(subscriber.mock.calls.at(-1)?.[0]).toMatchObject({
      conversationId: 'conv-drop',
      status: 'aborted',
      messages: [],
    })
    expect(stateFeedSubscriber.mock.calls.at(-1)?.[0]).toMatchObject({
      conversationId: 'conv-drop',
      status: 'aborted',
      messages: [],
    })
    expect(internals.conversationEntries.has('conv-drop')).toBe(false)
    expect(internals.persistTimers.has('conv-drop')).toBe(false)
    expect(
      internals.pendingScheduledConversationPublishes.has('conv-drop'),
    ).toBe(false)
    expect(internals.autoRunScheduled.has('conv-drop')).toBe(false)
    expect(internals.pendingBackgroundTaskResults.has('conv-drop')).toBe(false)
    expect(internals.pendingUserMessagesByKey.has('conv-drop::default')).toBe(
      false,
    )
    expect(internals.continuationScheduledByKey.has('conv-drop::default')).toBe(
      false,
    )
    expect(
      internals.foregroundToolAbortersByConversation.has('conv-drop'),
    ).toBe(false)

    jest.runOnlyPendingTimers()
    expect(persistConversationMessages).not.toHaveBeenCalled()
  })

  it('does not let stale reads, subscriptions, or writes recreate a dropped conversation', async () => {
    const persistConversationMessages = jest.fn().mockResolvedValue(undefined)
    const service = new AgentService({ persistConversationMessages })
    const internals = getAgentServiceInternals(service)

    service.replaceConversationMessages('conv-no-revive', [
      makeUserMessage('u1', 'hi'),
    ])
    service.dropConversation('conv-no-revive')

    expect(service.getState('conv-no-revive')).toMatchObject({
      conversationId: 'conv-no-revive',
      status: 'aborted',
      messages: [],
    })
    expect(internals.conversationEntries.has('conv-no-revive')).toBe(false)

    const subscriber = jest.fn()
    service.subscribe('conv-no-revive', subscriber)
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-no-revive',
        status: 'aborted',
        messages: [],
      }),
    )
    expect(internals.conversationEntries.has('conv-no-revive')).toBe(false)

    expect(service.getConversationRunSummary('conv-no-revive')).toMatchObject({
      conversationId: 'conv-no-revive',
      status: 'aborted',
      isActive: false,
    })
    expect(internals.conversationEntries.has('conv-no-revive')).toBe(false)

    service.replaceConversationMessages('conv-no-revive', [
      makeUserMessage('u2', 'revive'),
    ])
    await service.run({
      conversationId: 'conv-no-revive',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-no-revive', [
        makeUserMessage('u3', 'run'),
      ]),
    })

    expect(runtimeInstances).toHaveLength(0)
    expect(internals.conversationEntries.has('conv-no-revive')).toBe(false)
    jest.runOnlyPendingTimers()
    expect(persistConversationMessages).not.toHaveBeenCalled()
  })

  it('does not create a conversation entry when checking an unknown running state', () => {
    const service = new AgentService()
    const internals = getAgentServiceInternals(service)

    expect(service.isRunning('conv-never-created')).toBe(false)
    expect(internals.conversationEntries.has('conv-never-created')).toBe(false)
  })

  it('does not recreate a dropped conversation when an aborted run settles', async () => {
    const persistConversationMessages = jest.fn().mockResolvedValue(undefined)
    const abortToolCall = jest.fn()
    const service = new AgentService({ persistConversationMessages })
    const internals = getAgentServiceInternals(service)
    const userMessage = makeUserMessage('u1', 'run')
    const runPromise = service.run({
      conversationId: 'conv-running-drop',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: {
        conversationId: 'conv-running-drop',
        messages: [userMessage],
        mcpManager: { abortToolCall },
      } as unknown as AgentRuntimeRunInput,
    })
    const runtime = runtimeInstances[0]

    runtime.emitSnapshot([
      userMessage,
      makeToolMessage(ToolCallResponseStatus.Running, 'tool-call-running'),
    ])
    expect(
      service.enqueueUserMessage(
        'conv-running-drop',
        makeUserMessage('queued-1', 'queued'),
      ),
    ).toBe('enqueued')

    service.dropConversation('conv-running-drop')

    expect(runtime.abort).toHaveBeenCalledTimes(1)
    expect(abortToolCall).toHaveBeenCalledWith('tool-call-running')
    expect(internals.conversationEntries.has('conv-running-drop')).toBe(false)
    expect(internals.runEntriesByKey.has('conv-running-drop::default')).toBe(
      false,
    )
    expect(
      internals.pendingUserMessagesByKey.has('conv-running-drop::default'),
    ).toBe(false)

    runtime.resolveRun()
    await runPromise

    expect(internals.conversationEntries.has('conv-running-drop')).toBe(false)
    expect(internals.runEntriesByKey.has('conv-running-drop::default')).toBe(
      false,
    )
    jest.runOnlyPendingTimers()
    expect(persistConversationMessages).not.toHaveBeenCalled()
  })

  it('ignores background subagent completions after a conversation was dropped', () => {
    const service = new AgentService()
    const internals = getAgentServiceInternals(service)
    const record = {
      ...makeFailedSubagentTaskRecord(),
      conversationId: 'conv-background-drop',
    }
    subagentTaskRegistry.register(record)
    service.startBackgroundTaskResultListener()

    try {
      service.dropConversation(record.conversationId)
      backgroundTaskCompletionBus.pushCompleted({
        kind: 'subagent',
        taskId: record.taskId,
        conversationId: record.conversationId,
        record,
      })

      expect(internals.conversationEntries.has(record.conversationId)).toBe(
        false,
      )
      expect(
        subagentTaskRegistry.get(record.taskId)?.liveTranscript,
      ).toBeUndefined()
      expect(
        subagentTaskRegistry.get(record.taskId)?.result?.transcript,
      ).toBeUndefined()
    } finally {
      service.stopBackgroundTaskResultListener()
    }
  })
})

describe('AgentService main activity summary', () => {
  beforeEach(() => {
    runtimeInstances.length = 0
  })

  it('marks a live runtime as active, abortable, and queueable', async () => {
    const service = new AgentService()
    const runPromise = service.run({
      conversationId: 'conv-live',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-live', [makeUserMessage('u1', 'hello')]),
    })

    expect(service.getConversationRunSummary('conv-live')).toMatchObject({
      isRunning: true,
      isActive: true,
      isAbortable: true,
      isQueueable: true,
      isWaitingApproval: false,
      isWaitingUserInput: false,
    })

    runtimeInstances[0].resolveRun()
    await runPromise
  })

  it('marks pending approval and awaiting user input as active but not queueable', () => {
    const service = new AgentService()

    service.replaceConversationMessages('conv-pending', [
      makeUserMessage('u1', 'hi'),
      makeToolMessage(ToolCallResponseStatus.PendingApproval),
    ])
    expect(service.getConversationRunSummary('conv-pending')).toMatchObject({
      isActive: true,
      isAbortable: true,
      isQueueable: false,
      isWaitingApproval: true,
      isWaitingUserInput: false,
    })

    service.replaceConversationMessages('conv-awaiting', [
      makeUserMessage('u1', 'hi'),
      makeToolMessage(ToolCallResponseStatus.AwaitingUserInput),
    ])
    expect(service.getConversationRunSummary('conv-awaiting')).toMatchObject({
      isActive: true,
      isAbortable: true,
      isQueueable: false,
      isWaitingApproval: true,
      isWaitingUserInput: true,
    })
  })

  it('marks foreground running tool calls as active without treating background results as active', () => {
    const service = new AgentService()

    service.replaceConversationMessages('conv-tool', [
      makeUserMessage('u1', 'hi'),
      makeToolMessage(ToolCallResponseStatus.Running),
    ])
    expect(service.getConversationRunSummary('conv-tool')).toMatchObject({
      isRunning: false,
      isActive: true,
      isAbortable: true,
      isQueueable: false,
    })

    service.replaceConversationMessages('conv-background', [
      makeUserMessage('u1', 'hi'),
      makeRunningTerminalResultMessage(),
      makeCompletedSubagentResultMessage(),
    ])
    expect(service.getConversationRunSummary('conv-background')).toMatchObject({
      isRunning: false,
      isActive: false,
      isAbortable: false,
      isQueueable: false,
    })
  })

  it('aborts foreground tool calls without an active runtime and leaves background results untouched', () => {
    const service = new AgentService()
    service.replaceConversationMessages('conv-stop-tool', [
      makeUserMessage('u1', 'hi'),
      makeToolMessage(ToolCallResponseStatus.Running),
    ])

    expect(service.abortConversationMainActivity('conv-stop-tool')).toBe(true)
    const stoppedTool = service
      .getState('conv-stop-tool')
      .messages.find((message) => message.role === 'tool')
    expect(stoppedTool).toMatchObject({
      role: 'tool',
      toolCalls: [{ response: { status: ToolCallResponseStatus.Aborted } }],
    })

    service.replaceConversationMessages('conv-stop-background', [
      makeUserMessage('u1', 'hi'),
      makeRunningTerminalResultMessage(),
    ])
    expect(service.abortConversationMainActivity('conv-stop-background')).toBe(
      false,
    )
    expect(service.getState('conv-stop-background').messages[1]).toMatchObject({
      role: 'terminal_command_result',
      status: 'running',
    })
  })

  it('calls the registered foreground aborter when stopping main activity', () => {
    const service = new AgentService()
    const abort = jest.fn()
    service.replaceConversationMessages('conv-tracker', [
      makeUserMessage('u1', 'hi'),
      makeToolMessage(ToolCallResponseStatus.Running, 'tracked-call'),
    ])
    const unregister = service.registerForegroundToolAborter({
      conversationId: 'conv-tracker',
      toolCallId: 'tracked-call',
      abort,
    })

    expect(service.abortConversationMainActivity('conv-tracker')).toBe(true)
    expect(abort).toHaveBeenCalledTimes(1)
    unregister()
  })
})

describe('AgentService background subagent results', () => {
  it('persists live transcript fallback before compacting completed registry records', () => {
    const service = new AgentService()
    const record = makeFailedSubagentTaskRecord()
    subagentTaskRegistry.register(record)
    service.startBackgroundTaskResultListener()

    try {
      backgroundTaskCompletionBus.pushCompleted({
        kind: 'subagent',
        taskId: record.taskId,
        conversationId: record.conversationId,
        record,
      })

      const subagentResult = service
        .getState(record.conversationId)
        .messages.find((message) => message.role === 'subagent_result')
      expect(subagentResult).toMatchObject({
        role: 'subagent_result',
        taskId: record.taskId,
        transcript: record.liveTranscript,
      })
      expect(
        subagentTaskRegistry.get(record.taskId)?.liveTranscript,
      ).toBeUndefined()
      expect(
        subagentTaskRegistry.get(record.taskId)?.result?.transcript,
      ).toBeUndefined()
    } finally {
      service.stopBackgroundTaskResultListener()
    }
  })
})

const waitForRuntimeCount = async (count: number): Promise<void> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (runtimeInstances.length >= count) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`Expected ${count} runtime instances`)
}

const makeAssistantToolMessages = ({
  userMessage,
  responseStatus,
  toolName = 'server__tool',
}: {
  userMessage: ChatUserMessage
  responseStatus:
    | ToolCallResponseStatus.PendingApproval
    | ToolCallResponseStatus.AwaitingUserInput
  toolName?: string
}): ChatMessage[] => {
  const request = {
    id: 'call-1',
    name: toolName,
    arguments: {
      kind: 'complete' as const,
      value: {},
    },
  }
  return [
    userMessage,
    {
      role: 'assistant',
      id: 'assistant-1',
      content: '',
      metadata: {
        generationState: 'completed',
      },
      toolCallRequests: [request],
    },
    {
      role: 'tool',
      id: 'tool-1',
      toolCalls: [
        {
          request,
          response: {
            status: responseStatus,
          },
        },
      ],
    },
  ]
}

describe('AgentService continuation input', () => {
  beforeEach(() => {
    runtimeInstances.length = 0
  })

  it('drops stale requestMessages when continuing after approved tool calls', async () => {
    const service = new AgentService()
    const userMessage = makeUserMessage('u1', 'dispatch once')
    const staleRequestMessages = [userMessage]
    const callTool = jest.fn().mockResolvedValue({
      status: ToolCallResponseStatus.Success,
      data: {
        type: 'text',
        text: 'accepted',
      },
    })

    const runPromise = service.run({
      conversationId: 'conv-approve-cont',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: {
        conversationId: 'conv-approve-cont',
        messages: [userMessage],
        requestMessages: staleRequestMessages,
        model: {
          id: 'model-1',
        },
        mcpManager: {
          callTool,
        },
      } as unknown as AgentRuntimeRunInput,
    })
    const firstRuntime = runtimeInstances[0]
    firstRuntime.emitSnapshot(
      makeAssistantToolMessages({
        userMessage,
        responseStatus: ToolCallResponseStatus.PendingApproval,
      }),
    )

    const approvePromise = service.approveToolCall({
      conversationId: 'conv-approve-cont',
      toolCallId: 'call-1',
    })

    await waitForRuntimeCount(2)
    const continuationInput = runtimeInstances[1].getRunInput()
    expect(continuationInput?.requestMessages).toBeUndefined()
    expect(continuationInput?.messages).not.toEqual(staleRequestMessages)

    const toolMessage = continuationInput?.messages.find(
      (message) => message.role === 'tool',
    )
    if (!toolMessage || toolMessage.role !== 'tool') {
      throw new Error('expected continued tool message')
    }
    expect(toolMessage.toolCalls[0].response).toMatchObject({
      status: ToolCallResponseStatus.Success,
      data: {
        text: 'accepted',
      },
    })

    runtimeInstances[1].resolveRun()
    expect(await approvePromise).toBe(true)
    firstRuntime.resolveRun()
    await runPromise
  })

  it('drops stale requestMessages when continuing after answered user questions', async () => {
    const service = new AgentService()
    const userMessage = makeUserMessage('u1', 'ask then continue')
    const staleRequestMessages = [userMessage]

    const runPromise = service.run({
      conversationId: 'conv-answer-cont',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: {
        conversationId: 'conv-answer-cont',
        messages: [userMessage],
        requestMessages: staleRequestMessages,
      } as unknown as AgentRuntimeRunInput,
    })
    const firstRuntime = runtimeInstances[0]
    firstRuntime.emitSnapshot(
      makeAssistantToolMessages({
        userMessage,
        responseStatus: ToolCallResponseStatus.AwaitingUserInput,
        toolName: 'yolo_local__ask_user_question',
      }),
    )

    const answerPromise = service.answerUserQuestion({
      conversationId: 'conv-answer-cont',
      toolCallId: 'call-1',
      payload: {
        type: 'user_answers',
        answers: [],
      },
    })

    await waitForRuntimeCount(2)
    const continuationInput = runtimeInstances[1].getRunInput()
    expect(continuationInput?.requestMessages).toBeUndefined()
    expect(continuationInput?.messages).not.toEqual(staleRequestMessages)

    const toolMessage = continuationInput?.messages.find(
      (message) => message.role === 'tool',
    )
    if (!toolMessage || toolMessage.role !== 'tool') {
      throw new Error('expected continued tool message')
    }
    expect(toolMessage.toolCalls[0].response.status).toBe(
      ToolCallResponseStatus.Success,
    )

    runtimeInstances[1].resolveRun()
    expect(await answerPromise).toEqual({ kind: 'continued' })
    firstRuntime.resolveRun()
    await runPromise
  })
})

describe('AgentService mid-run user message queue', () => {
  beforeEach(() => {
    runtimeInstances.length = 0
  })

  it('returns idle when no run is active', () => {
    const service = new AgentService()
    const result = service.enqueueUserMessage(
      'conv-idle',
      makeUserMessage('u1', 'hello'),
    )
    expect(result).toBe('idle')
    expect(service.peekPendingUserMessages('conv-idle')).toEqual([])
  })

  it('enqueues a message while a run is active', async () => {
    const service = new AgentService()
    const runPromise = service.run({
      conversationId: 'conv-1',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-1', [makeUserMessage('u1', 'hello')]),
    })
    const runtime = runtimeInstances[0]

    const queued = makeUserMessage('u2', 'follow-up')
    const result = service.enqueueUserMessage('conv-1', queued)
    expect(result).toBe('enqueued')
    expect(service.peekPendingUserMessages('conv-1')).toEqual([queued])

    runtime.resolveRun()
    await runPromise
  })

  it('refuses enqueue when a tool call is pending approval', async () => {
    const service = new AgentService()
    const runPromise = service.run({
      conversationId: 'conv-approval',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-approval', [makeUserMessage('u1', 'hi')]),
    })
    const runtime = runtimeInstances[0]

    runtime.emitSnapshot([
      {
        role: 'tool',
        id: 'tool-1',
        toolCalls: [
          {
            request: { id: 'call-1', name: 'local:fs_write' },
            response: { status: ToolCallResponseStatus.PendingApproval },
          },
        ],
      } as ChatMessage,
    ])

    const result = service.enqueueUserMessage(
      'conv-approval',
      makeUserMessage('u2', 'no go'),
    )
    expect(result).toBe('blocked_awaiting_approval')
    expect(service.peekPendingUserMessages('conv-approval')).toEqual([])

    runtime.resolveRun()
    await runPromise
  })

  it('drains the queue when the runtime hits an llm_request boundary', async () => {
    const service = new AgentService()
    const runPromise = service.run({
      conversationId: 'conv-drain',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-drain', [makeUserMessage('u1', 'hi')]),
    })
    const runtime = runtimeInstances[0]

    const queued = makeUserMessage('u2', 'queued')
    expect(service.enqueueUserMessage('conv-drain', queued)).toBe('enqueued')

    const captured = runtime.getRunInput()
    expect(captured?.drainPendingUserMessages).toBeDefined()
    const drained = captured?.drainPendingUserMessages?.() ?? []
    expect(drained).toEqual([queued])
    expect(service.peekPendingUserMessages('conv-drain')).toEqual([])

    runtime.resolveRun()
    await runPromise
  })

  it('atomically removes a message while it is still queued', async () => {
    const service = new AgentService()
    const runPromise = service.run({
      conversationId: 'conv-remove',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-remove', [makeUserMessage('u1', 'hi')]),
    })
    const runtime = runtimeInstances[0]
    const first = makeUserMessage('u2', 'first')
    const second = makeUserMessage('u3', 'second')

    expect(service.enqueueUserMessage('conv-remove', first)).toBe('enqueued')
    expect(service.enqueueUserMessage('conv-remove', second)).toBe('enqueued')

    expect(service.removePendingUserMessage('conv-remove', 'u2')).toEqual(first)
    expect(service.peekPendingUserMessages('conv-remove')).toEqual([second])
    expect(
      service.removePendingUserMessage('conv-remove', 'missing'),
    ).toBeNull()

    runtime.resolveRun()
    await runPromise
  })

  it('cannot remove a message after the runtime has drained it', async () => {
    const service = new AgentService()
    const runPromise = service.run({
      conversationId: 'conv-remove-drained',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-remove-drained', [
        makeUserMessage('u1', 'hi'),
      ]),
    })
    const runtime = runtimeInstances[0]
    const queued = makeUserMessage('u2', 'queued')
    expect(service.enqueueUserMessage('conv-remove-drained', queued)).toBe(
      'enqueued',
    )

    runtime.getRunInput()?.drainPendingUserMessages?.()

    expect(
      service.removePendingUserMessage('conv-remove-drained', 'u2'),
    ).toBeNull()

    runtime.resolveRun()
    await runPromise
  })

  it('refuses enqueue for non-default branches', async () => {
    const service = new AgentService()
    const runPromise = service.run({
      conversationId: 'conv-branch',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: {
        conversationId: 'conv-branch',
        branchId: 'branch-x',
        sourceUserMessageId: 'u1',
        messages: [makeUserMessage('u1', 'hi')],
      } as unknown as AgentRuntimeRunInput,
    })
    const runtime = runtimeInstances[0]

    const result = service.enqueueUserMessage(
      'conv-branch',
      makeUserMessage('u2', 'follow up'),
      'branch-x',
    )
    expect(result).toBe('idle')

    runtime.resolveRun()
    await runPromise
  })

  it('clears the queue and emits an abort event when aborted', async () => {
    const service = new AgentService()
    const runPromise = service.run({
      conversationId: 'conv-abort',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-abort', [makeUserMessage('u1', 'hi')]),
    })
    const runtime = runtimeInstances[0]

    const queued = makeUserMessage('u2', 'queued')
    expect(service.enqueueUserMessage('conv-abort', queued)).toBe('enqueued')

    const aborted: ChatUserMessage[] = []
    service.subscribeToAbortedQueuedMessages((_, messages) => {
      aborted.push(...messages)
    })

    expect(service.abortConversation('conv-abort')).toBe(true)
    expect(aborted).toEqual([queued])
    expect(service.peekPendingUserMessages('conv-abort')).toEqual([])

    runtime.resolveRun()
    await runPromise
  })

  it('starts a continuation run when the queue still has messages after run completion', async () => {
    const service = new AgentService()
    const runPromise = service.run({
      conversationId: 'conv-cont',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-cont', [makeUserMessage('u1', 'hi')]),
    })
    const firstRuntime = runtimeInstances[0]

    // Enqueue a follow-up message without draining (simulating a run that
    // finished — fast path or no llm_request boundary occurred after the
    // enqueue).
    const queued = makeUserMessage('u2', 'queued-followup')
    expect(service.enqueueUserMessage('conv-cont', queued)).toBe('enqueued')

    firstRuntime.resolveRun()
    await runPromise

    // Yield to the microtask + macrotask queue so the after-run continuation
    // microtask can fire and the new run can begin (its synchronous prelude
    // pushes a new runtime instance into `runtimeInstances`).
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(runtimeInstances.length).toBe(2)
    const secondRuntime = runtimeInstances[1]
    const secondInput = secondRuntime.getRunInput()
    expect(secondInput?.drainPendingUserMessages).toBeDefined()
    // The queue is preserved for the new run's drain to pick up.
    expect(service.peekPendingUserMessages('conv-cont')).toEqual([queued])

    secondRuntime.resolveRun()
  })

  it('refuses enqueue when the active run is on the single-turn fast path', async () => {
    const service = new AgentService()
    const runPromise = service.run({
      conversationId: 'conv-fast',
      loopConfig: {
        enableTools: false,
        maxAutoIterations: 1,
        includeBuiltinTools: false,
      },
      input: buildBaseRunInput('conv-fast', [makeUserMessage('u1', 'hi')]),
    })
    const runtime = runtimeInstances[0]

    const result = service.enqueueUserMessage(
      'conv-fast',
      makeUserMessage('u2', 'follow-up'),
    )
    expect(result).toBe('idle')
    expect(service.peekPendingUserMessages('conv-fast')).toEqual([])

    runtime.resolveRun()
    await runPromise
  })

  it('does not schedule continuation for fast-path runs even if the queue is non-empty', async () => {
    const service = new AgentService()
    const runPromise = service.run({
      conversationId: 'conv-fast-cont',
      loopConfig: {
        enableTools: false,
        maxAutoIterations: 1,
        includeBuiltinTools: false,
      },
      input: buildBaseRunInput('conv-fast-cont', [makeUserMessage('u1', 'hi')]),
    })
    const firstRuntime = runtimeInstances[0]

    // Bypass the enqueue API guard to simulate any path that could leave a
    // message queued under a fast-path run. The continuation guard must keep
    // us from looping forever even in that scenario.
    const runKey = 'conv-fast-cont::__default__'

    ;(service as any).pendingUserMessagesByKey.set(runKey, [
      makeUserMessage('u2', 'orphan'),
    ])

    firstRuntime.resolveRun()
    await runPromise

    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    // No continuation run should have spawned.
    expect(runtimeInstances.length).toBe(1)
  })
})

describe('AgentService subagent approval routing', () => {
  type FakeRuntime = {
    findToolCall: jest.Mock
    setToolCallResponse: jest.Mock
    getMessages: jest.Mock
  }

  const makeFakeRuntime = (toolCallId: string): FakeRuntime => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        id: 'tool-msg-1',
        metadata: {},
        toolCalls: [
          {
            request: {
              id: toolCallId,
              name: 'yolo_local__fs_edit',
              arguments: undefined,
            },
            response: { status: ToolCallResponseStatus.PendingApproval },
          },
        ],
      },
    ]
    return {
      findToolCall: jest.fn().mockImplementation((id: string) => {
        if (id !== toolCallId) return null
        return {
          toolMessage: messages[0],
          toolCall: (messages[0] as Extract<ChatMessage, { role: 'tool' }>)
            .toolCalls[0],
        }
      }),
      setToolCallResponse: jest.fn().mockReturnValue(true),
      getMessages: jest.fn().mockReturnValue(messages),
    }
  }

  type FakeMcpManager = {
    callTool: jest.Mock
    allowToolForConversation: jest.Mock
  }

  const makeFakeMcpManager = (): FakeMcpManager => ({
    callTool: jest.fn().mockResolvedValue({
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: 'ok' },
    }),
    allowToolForConversation: jest.fn(),
  })

  const registerEntry = ({
    taskId = 'sub_test',
    toolCallId = 'tool-call-x',
  }: { taskId?: string; toolCallId?: string } = {}) => {
    const runtime = makeFakeRuntime(toolCallId)
    const mcpManager = makeFakeMcpManager()
    const resumeRun = jest.fn().mockResolvedValue(undefined)
    subagentRuntimeRegistry.register({
      taskId,
      runtime: runtime as unknown as Parameters<
        typeof subagentRuntimeRegistry.register
      >[0]['runtime'],
      mcpManager: mcpManager as unknown as Parameters<
        typeof subagentRuntimeRegistry.register
      >[0]['mcpManager'],
      parentConversationId: 'conv-parent',
      parentToolCallId: 'parent-call-1',
      resumeRun,
    })
    return { taskId, toolCallId, runtime, mcpManager, resumeRun }
  }

  afterEach(() => {
    for (const entry of subagentRuntimeRegistry.list()) {
      subagentRuntimeRegistry.unregister(entry.taskId)
    }
    runtimeInstances.length = 0
  })

  it('approveToolCall routes to the subagent runtime, executes, and resumes', async () => {
    const { toolCallId, runtime, mcpManager, resumeRun } = registerEntry()
    const service = new AgentService()

    const ok = await service.approveToolCall({
      conversationId: 'irrelevant-parent-conv',
      toolCallId,
    })

    expect(ok).toBe(true)
    expect(mcpManager.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'yolo_local__fs_edit',
        id: toolCallId,
        conversationId: 'conv-parent',
      }),
    )
    // Two patches: PendingApproval -> Running, then Running -> Success.
    expect(runtime.setToolCallResponse).toHaveBeenCalledTimes(2)
    expect(runtime.setToolCallResponse).toHaveBeenNthCalledWith(1, toolCallId, {
      status: ToolCallResponseStatus.Running,
    })
    expect(runtime.setToolCallResponse).toHaveBeenNthCalledWith(
      2,
      toolCallId,
      expect.objectContaining({ status: ToolCallResponseStatus.Success }),
    )
    expect(resumeRun).toHaveBeenCalledTimes(1)
  })

  it('approveToolCall with allowForConversation scopes the allow to the parent conv', async () => {
    const { toolCallId, mcpManager } = registerEntry()
    const service = new AgentService()

    await service.approveToolCall({
      conversationId: 'irrelevant',
      toolCallId,
      allowForConversation: true,
    })

    expect(mcpManager.allowToolForConversation).toHaveBeenCalledWith(
      'yolo_local__fs_edit',
      'conv-parent',
      undefined,
    )
  })

  it('rejectToolCall routes to the subagent runtime and resumes', () => {
    const { toolCallId, runtime, mcpManager, resumeRun } = registerEntry()
    const service = new AgentService()

    const ok = service.rejectToolCall({
      conversationId: 'irrelevant',
      toolCallId,
    })

    expect(ok).toBe(true)
    expect(runtime.setToolCallResponse).toHaveBeenCalledWith(toolCallId, {
      status: ToolCallResponseStatus.Rejected,
    })
    expect(mcpManager.callTool).not.toHaveBeenCalled()
    expect(resumeRun).toHaveBeenCalledTimes(1)
  })

  it('approveToolCall surfaces callTool errors as Error response', async () => {
    const { toolCallId, runtime, mcpManager } = registerEntry()
    mcpManager.callTool.mockRejectedValueOnce(new Error('boom'))
    const service = new AgentService()

    await service.approveToolCall({
      conversationId: 'irrelevant',
      toolCallId,
    })

    const lastCall =
      runtime.setToolCallResponse.mock.calls[
        runtime.setToolCallResponse.mock.calls.length - 1
      ]
    expect(lastCall?.[1]).toEqual(
      expect.objectContaining({
        status: ToolCallResponseStatus.Error,
        error: expect.stringContaining('boom'),
      }),
    )
  })

  it('approveToolCall returns false when the runtime no longer hosts the call', async () => {
    const { toolCallId, runtime } = registerEntry()
    // Simulate a race: the call was already resolved before approve fired.
    runtime.findToolCall.mockReturnValueOnce(null)
    const service = new AgentService()

    const ok = await service.approveToolCall({
      conversationId: 'irrelevant',
      toolCallId,
    })

    expect(ok).toBe(false)
  })
})
