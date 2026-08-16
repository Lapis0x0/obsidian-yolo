import { ChatMessage, ChatUserMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { backgroundTaskCompletionBus } from './background-task/completion-bus'
import { AgentService, RUNNING_PERSIST_MIN_INTERVAL_MS } from './service'
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

describe('AgentService assistant render stream separation', () => {
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

  it('keeps pure display deltas out of the conversation snapshot and routes them to the render stream', async () => {
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

    // Streaming deltas replace the message reference immutably (matching the
    // real runtime's contract) rather than mutating one shared object, so
    // each snapshot below is a distinct object with the same metadata
    // reference — a render-stream-only content change.
    const firstAssistantMessage = makeStreamingAssistantMessage('a') as Extract<
      ChatMessage,
      { role: 'assistant' }
    >
    runtime.emitSnapshot([userMessage, firstAssistantMessage])
    expect(publishedStates).toHaveLength(2)
    const firstPublishedAssistant = publishedStates.at(-1)?.at(-1)

    const secondAssistantMessage = { ...firstAssistantMessage, content: 'ab' }
    runtime.emitSnapshot([userMessage, secondAssistantMessage])
    const thirdAssistantMessage = { ...secondAssistantMessage, content: 'abc' }
    runtime.emitSnapshot([userMessage, thirdAssistantMessage])

    // No frame publish, no timer publish: the snapshot keeps the last
    // structural fold value...
    jest.advanceTimersByTime(64)
    expect(publishedStates).toHaveLength(2)
    expect(firstPublishedAssistant).toMatchObject({
      role: 'assistant',
      content: 'a',
    })

    // ...while the render stream and the authoritative state both carry the
    // latest text.
    expect(
      service.getAssistantRenderStream(
        'conv-streaming-publish',
        'assistant-streaming',
      ),
    ).toMatchObject({ content: 'abc', phase: 'streaming', revision: 1 })
    expect(
      service.getState('conv-streaming-publish').messages.at(-1),
    ).toMatchObject({ role: 'assistant', content: 'abc' })

    runtime.resolveRun()
    await runPromise

    // The terminal fold carries the same text and settles the stream.
    expect(publishedStates.at(-1)?.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'abc',
    })
    expect(
      service.getAssistantRenderStream(
        'conv-streaming-publish',
        'assistant-streaming',
      ),
    ).toBeUndefined()
  })

  it('folds the first appearance of content back into the snapshot', async () => {
    const service = new AgentService()
    const publishedStates: ChatMessage[][] = []
    service.subscribe(
      'conv-first-appearance',
      (state) => {
        publishedStates.push(state.messages)
      },
      { emitCurrent: false },
    )

    const userMessage = makeUserMessage('u1', 'hello')
    const runPromise = service.run({
      conversationId: 'conv-first-appearance',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-first-appearance', [userMessage]),
    })
    const runtime = runtimeInstances[0]

    // The shell arrives with no text at all — the tree's "does this message
    // render anything" gates read the snapshot, so the first real character
    // has to fold back even though it is a display-only field.
    const shell = makeStreamingAssistantMessage('') as Extract<
      ChatMessage,
      { role: 'assistant' }
    >
    runtime.emitSnapshot([userMessage, shell])
    const publishesAfterShell = publishedStates.length

    runtime.emitSnapshot([userMessage, { ...shell, content: 'H' }])
    expect(publishedStates).toHaveLength(publishesAfterShell + 1)
    expect(publishedStates.at(-1)?.at(-1)).toMatchObject({ content: 'H' })

    runtime.emitSnapshot([userMessage, { ...shell, content: 'He' }])
    expect(publishedStates).toHaveLength(publishesAfterShell + 1)

    runtime.resolveRun()
    await runPromise
  })

  // 折回判据必须与树上的展示 gate 完全一致（它们一律是 `trim().length > 0`）。
  // 按 `length` 判定时，provider 先吐出的换行/空格会白白消耗掉唯一一次折回，
  // 等真正的第一个可见字符到来时反而只走 stream，gate 整段生成期间不翻转。
  it('folds on the first visible character, not on leading whitespace', async () => {
    const service = new AgentService()
    const publishedStates: ChatMessage[][] = []
    service.subscribe(
      'conv-whitespace-first',
      (state) => {
        publishedStates.push(state.messages)
      },
      { emitCurrent: false },
    )

    const userMessage = makeUserMessage('u1', 'hello')
    const runPromise = service.run({
      conversationId: 'conv-whitespace-first',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-whitespace-first', [userMessage]),
    })
    const runtime = runtimeInstances[0]

    const shell = makeStreamingAssistantMessage('') as Extract<
      ChatMessage,
      { role: 'assistant' }
    >
    runtime.emitSnapshot([userMessage, shell])
    const publishesAfterShell = publishedStates.length

    // 纯空白：树上没有任何 gate 会因此翻转，不该消耗折回。
    runtime.emitSnapshot([userMessage, { ...shell, content: '\n' }])
    runtime.emitSnapshot([userMessage, { ...shell, content: '\n ' }])
    runtime.emitSnapshot([userMessage, { ...shell, content: '\n \n\n' }])
    expect(publishedStates).toHaveLength(publishesAfterShell)

    // 第一个可见字符：这才是 gate 翻转的时刻，必须折回一次。
    runtime.emitSnapshot([userMessage, { ...shell, content: '\n \n\nH' }])
    expect(publishedStates).toHaveLength(publishesAfterShell + 1)
    expect(publishedStates.at(-1)?.at(-1)).toMatchObject({
      content: '\n \n\nH',
    })

    // 之后回到纯增量。
    runtime.emitSnapshot([userMessage, { ...shell, content: '\n \n\nHe' }])
    expect(publishedStates).toHaveLength(publishesAfterShell + 1)

    runtime.resolveRun()
    await runPromise
  })

  it('folds on the first visible reasoning character, not on leading whitespace', async () => {
    const service = new AgentService()
    const publishedStates: ChatMessage[][] = []
    service.subscribe(
      'conv-whitespace-reasoning',
      (state) => {
        publishedStates.push(state.messages)
      },
      { emitCurrent: false },
    )

    const userMessage = makeUserMessage('u1', 'hello')
    const runPromise = service.run({
      conversationId: 'conv-whitespace-reasoning',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-whitespace-reasoning', [userMessage]),
    })
    const runtime = runtimeInstances[0]

    const shell = makeStreamingAssistantMessage('', {
      reasoning: '',
    }) as Extract<ChatMessage, { role: 'assistant' }>
    runtime.emitSnapshot([userMessage, shell])
    const publishesAfterShell = publishedStates.length

    runtime.emitSnapshot([userMessage, { ...shell, reasoning: '\n\n' }])
    expect(publishedStates).toHaveLength(publishesAfterShell)

    runtime.emitSnapshot([userMessage, { ...shell, reasoning: '\n\nT' }])
    expect(publishedStates).toHaveLength(publishesAfterShell + 1)
    expect(publishedStates.at(-1)?.at(-1)).toMatchObject({
      reasoning: '\n\nT',
    })

    runtime.resolveRun()
    await runPromise
  })

  // 事务顺序：最终值 → 结构快照 → 定格。终态值必须是最终值本身，而不是最后
  // 一个 delta——provider 的最终结果可能重写正文、规范化 reasoning。
  it('settles the stream on the final value, after the structural snapshot', async () => {
    const service = new AgentService()
    const events: string[] = []
    service.subscribe(
      'conv-terminal-final',
      (state) => {
        const last = state.messages.at(-1)
        events.push(
          `snapshot:${last?.role === 'assistant' ? last.content : ''}`,
        )
      },
      { emitCurrent: false },
    )
    service.subscribeAssistantRenderStream(
      'conv-terminal-final',
      'assistant-streaming',
      (value) => {
        events.push(`stream:${value.phase}:${value.content}`)
      },
    )

    const userMessage = makeUserMessage('u1', 'hello')
    const runPromise = service.run({
      conversationId: 'conv-terminal-final',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-terminal-final', [userMessage]),
    })
    const runtime = runtimeInstances[0]

    const streamingAssistant = makeStreamingAssistantMessage('ab', {
      reasoning: 'raw  reasoning\n\n',
    }) as Extract<ChatMessage, { role: 'assistant' }>
    runtime.emitSnapshot([userMessage, streamingAssistant])
    runtime.emitSnapshot([
      userMessage,
      { ...streamingAssistant, content: 'abc' },
    ])

    const eventsBeforeFinal = events.length

    // provider 收尾：最终正文与 reasoning 都与最后一个 delta 不同。
    runtime.emitSnapshot([
      userMessage,
      {
        ...streamingAssistant,
        content: 'abc final',
        reasoning: 'normalized reasoning',
        metadata: { generationState: 'completed' as const },
      },
    ])

    expect(events.slice(eventsBeforeFinal)).toEqual([
      'stream:streaming:abc final',
      'snapshot:abc final',
      'stream:terminal:abc final',
    ])
    expect(
      service.getAssistantRenderStream(
        'conv-terminal-final',
        'assistant-streaming',
      ),
    ).toMatchObject({
      content: 'abc final',
      reasoning: 'normalized reasoning',
      phase: 'terminal',
    })

    runtime.resolveRun()
    await runPromise
  })

  it('notifies run summary subscribers on semantic events only, never on display deltas', async () => {
    const service = new AgentService()
    const summarySubscriber = jest.fn()
    service.subscribeToRunSummaries(summarySubscriber)
    // Initial emit on subscribe.
    expect(summarySubscriber).toHaveBeenCalledTimes(1)

    const stateSubscriber = jest.fn()
    service.subscribe('conv-summary-routing', stateSubscriber, {
      emitCurrent: false,
    })

    const userMessage = makeUserMessage('u1', 'hello')
    const runPromise = service.run({
      conversationId: 'conv-summary-routing',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-summary-routing', [userMessage]),
    })
    const runtime = runtimeInstances[0]

    const firstAssistantMessage = makeStreamingAssistantMessage('a') as Extract<
      ChatMessage,
      { role: 'assistant' }
    >
    runtime.emitSnapshot([userMessage, firstAssistantMessage])

    // Run start and the first assistant message are semantic events: the
    // summary flipped to active and must have been re-broadcast.
    const callsAfterFirstSnapshot = summarySubscriber.mock.calls.length
    expect(callsAfterFirstSnapshot).toBeGreaterThan(1)
    const activeSummaries = summarySubscriber.mock.calls.at(-1)?.[0] as Map<
      string,
      { isActive: boolean }
    >
    expect(activeSummaries.get('conv-summary-routing')?.isActive).toBe(true)

    // Pure display deltas reach neither state subscribers nor run summary
    // subscribers: they travel on the render stream instead.
    const stateCallsBeforeDeltas = stateSubscriber.mock.calls.length
    runtime.emitSnapshot([
      userMessage,
      { ...firstAssistantMessage, content: 'ab' },
    ])
    runtime.emitSnapshot([
      userMessage,
      { ...firstAssistantMessage, content: 'abc' },
    ])
    jest.advanceTimersByTime(64)
    expect(stateSubscriber.mock.calls.length).toBe(stateCallsBeforeDeltas)
    expect(summarySubscriber).toHaveBeenCalledTimes(callsAfterFirstSnapshot)

    // Completion is a semantic event again.
    runtime.resolveRun()
    await runPromise
    expect(summarySubscriber.mock.calls.length).toBeGreaterThan(
      callsAfterFirstSnapshot,
    )
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

    const firstAssistantMessage = makeStreamingAssistantMessage('a') as Extract<
      ChatMessage,
      { role: 'assistant' }
    >
    runtime.emitSnapshot([userMessage, firstAssistantMessage])
    expect(subscriber).toHaveBeenCalledTimes(2)

    const secondAssistantMessage = { ...firstAssistantMessage, content: 'ab' }
    runtime.emitSnapshot([userMessage, secondAssistantMessage])
    expect(subscriber).toHaveBeenCalledTimes(2)

    const thirdAssistantMessage = {
      ...secondAssistantMessage,
      toolCallRequests: [
        {
          id: 'call-1',
          name: 'local:fs_read',
          arguments: { kind: 'complete' as const, value: {} },
        },
      ],
    }
    runtime.emitSnapshot([userMessage, thirdAssistantMessage])
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

    const firstAssistantMessage = makeStreamingAssistantMessage('a') as Extract<
      ChatMessage,
      { role: 'assistant' }
    >
    runtime.emitSnapshot([userMessage, firstAssistantMessage])
    runtime.emitSnapshot([
      userMessage,
      { ...firstAssistantMessage, content: 'ab' },
    ])
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
    const firstAssistantMessage = makeStreamingAssistantMessage('a') as Extract<
      ChatMessage,
      { role: 'assistant' }
    >

    runtime.emitSnapshot([userMessage, firstAssistantMessage])
    const secondAssistantMessage = { ...firstAssistantMessage, content: 'ab' }
    runtime.emitSnapshot([userMessage, secondAssistantMessage])
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

describe('AgentService conversation persistence flush', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  it('persists the latest conversation state before returning', async () => {
    const persistConversationMessages = jest.fn().mockResolvedValue(undefined)
    const service = new AgentService({ persistConversationMessages })
    const message = makeUserMessage('u-flush', 'persist me')

    service.replaceConversationMessages('conv-flush', [message], [], {
      persistState: true,
    })
    await service.flushConversationPersistence('conv-flush')

    expect(persistConversationMessages).toHaveBeenCalledTimes(1)
    expect(persistConversationMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-flush',
        messages: [message],
      }),
    )
    jest.runOnlyPendingTimers()
    expect(persistConversationMessages).toHaveBeenCalledTimes(1)
  })
})

describe('AgentService conversation persistence cadence', () => {
  const makeStreamingAssistantMessage = (
    content: string,
  ): Extract<ChatMessage, { role: 'assistant' }> => ({
    role: 'assistant',
    id: 'assistant-streaming',
    content,
    metadata: { generationState: 'streaming' },
  })

  beforeEach(() => {
    runtimeInstances.length = 0
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  // Persistence is enqueued on a promise chain, so a fired timer only reaches
  // the persist callback on the next microtask.
  const advance = async (ms: number) => {
    jest.advanceTimersByTime(ms)
    await Promise.resolve()
    await Promise.resolve()
  }

  // Mirrors the real submit path: the user message is committed to the
  // conversation first, then the run starts.
  const startRun = async (conversationId: string) => {
    const persistConversationMessages = jest.fn().mockResolvedValue(undefined)
    const service = new AgentService({ persistConversationMessages })
    const userMessage = makeUserMessage('u1', 'hello')

    service.replaceConversationMessages(conversationId, [userMessage], [], {
      persistState: true,
    })
    // The user's own message is a commit point: it reaches disk without
    // waiting for the in-run interval.
    await advance(1)
    expect(persistConversationMessages).toHaveBeenCalledTimes(1)

    const runPromise = service.run({
      conversationId,
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput(conversationId, [userMessage]),
    })
    return {
      service,
      persistConversationMessages,
      runPromise,
      runtime: runtimeInstances[0],
      userMessage,
    }
  }

  it('does not write streaming display deltas to disk', async () => {
    const { persistConversationMessages, runtime, runPromise, userMessage } =
      await startRun('conv-persist-stream')

    const first = makeStreamingAssistantMessage('a')
    runtime.emitSnapshot([userMessage, first])
    // The assistant message appearing is a structural change, but it lands
    // inside the interval opened by the user message write above.
    await advance(1)
    expect(persistConversationMessages).toHaveBeenCalledTimes(1)

    for (const content of ['ab', 'abc', 'abcd']) {
      runtime.emitSnapshot([userMessage, { ...first, content }])
      await advance(16)
    }
    // Frame-cadence publishes happened, disk writes did not.
    expect(persistConversationMessages).toHaveBeenCalledTimes(1)

    runtime.resolveRun()
    await runPromise
  })

  it('coalesces in-run structural events to one write per interval', async () => {
    const { persistConversationMessages, runtime, runPromise, userMessage } =
      await startRun('conv-persist-events')

    // A burst of structural events (tool requests / results / boundaries)
    // arriving right after the run started must not each trigger a write.
    for (let index = 0; index < 10; index += 1) {
      runtime.emitSnapshot([
        userMessage,
        makeStreamingAssistantMessage(`chunk-${index}`),
        makeToolMessage(ToolCallResponseStatus.Running, `call-${index}`),
      ])
      await advance(1_000)
    }

    // 10 seconds of events, still inside the first interval.
    expect(persistConversationMessages).toHaveBeenCalledTimes(1)

    await advance(5_000)
    expect(persistConversationMessages).toHaveBeenCalledTimes(2)

    runtime.resolveRun()
    await runPromise
  })

  it('writes immediately once the run settles', async () => {
    const { persistConversationMessages, runtime, runPromise, userMessage } =
      await startRun('conv-persist-settle')

    runtime.emitSnapshot([userMessage, makeStreamingAssistantMessage('a')])
    await advance(1_000)
    expect(persistConversationMessages).toHaveBeenCalledTimes(1)

    runtime.resolveRun()
    await runPromise
    await advance(1)

    expect(persistConversationMessages).toHaveBeenCalledTimes(2)
  })

  it('flushes a pending in-run write on unload', async () => {
    const {
      service,
      persistConversationMessages,
      runtime,
      runPromise,
      userMessage,
    } = await startRun('conv-persist-unload')

    runtime.emitSnapshot([
      userMessage,
      makeStreamingAssistantMessage('a'),
      makeToolMessage(ToolCallResponseStatus.Running),
    ])
    await advance(1_000)
    expect(persistConversationMessages).toHaveBeenCalledTimes(1)

    service.flushAllConversationPersistence()
    await advance(0)
    expect(persistConversationMessages).toHaveBeenCalledTimes(2)

    runtime.resolveRun()
    await runPromise
  })

  it('flushes a streaming run that has no pending write left', async () => {
    const {
      service,
      persistConversationMessages,
      runtime,
      runPromise,
      userMessage,
    } = await startRun('conv-persist-unload-stream')

    const first = makeStreamingAssistantMessage('a')
    runtime.emitSnapshot([userMessage, first])
    // Let the coalesced write for the assistant message land, so the only
    // unwritten state left is streamed text — which schedules nothing.
    await advance(RUNNING_PERSIST_MIN_INTERVAL_MS)
    expect(persistConversationMessages).toHaveBeenCalledTimes(2)

    runtime.emitSnapshot([userMessage, { ...first, content: 'ab' }])
    await advance(16)
    expect(persistConversationMessages).toHaveBeenCalledTimes(2)

    service.flushAllConversationPersistence()
    await advance(0)
    expect(persistConversationMessages).toHaveBeenCalledTimes(3)
    // The flushed payload carries the text that was only ever streamed.
    expect(
      persistConversationMessages.mock.calls.at(-1)?.[0].messages.at(-1),
    ).toMatchObject({ role: 'assistant', content: 'ab' })

    runtime.resolveRun()
    await runPromise
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
      anchorMessageId: 'u1',
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
      anchorMessageId: 'u1',
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
      anchorMessageId: 'u1',
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
  requestMetadata,
}: {
  userMessage: ChatUserMessage
  responseStatus:
    | ToolCallResponseStatus.PendingApproval
    | ToolCallResponseStatus.AwaitingUserInput
  toolName?: string
  requestMetadata?: {
    approvalPolicy?: 'auto' | 'always-require-user'
    executionConstraints?: { bashReadOnly?: boolean }
  }
}): ChatMessage[] => {
  const request = {
    id: 'call-1',
    name: toolName,
    arguments: {
      kind: 'complete' as const,
      value: {},
    },
    ...(requestMetadata ? { metadata: requestMetadata } : {}),
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

  it('approveToolCall passes the persisted executionConstraints.bashReadOnly to mcpManager.callTool', async () => {
    const service = new AgentService()
    const userMessage = makeUserMessage('u1', 'dispatch once')
    const callTool = jest.fn().mockResolvedValue({
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: 'ok' },
    })

    const runPromise = service.run({
      conversationId: 'conv-approve-bashro',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: {
        conversationId: 'conv-approve-bashro',
        messages: [userMessage],
        model: { id: 'model-1' },
        mcpManager: { callTool },
      } as unknown as AgentRuntimeRunInput,
    })
    const firstRuntime = runtimeInstances[0]
    firstRuntime.emitSnapshot(
      makeAssistantToolMessages({
        userMessage,
        responseStatus: ToolCallResponseStatus.PendingApproval,
        toolName: 'yolo_local__bash',
        requestMetadata: { executionConstraints: { bashReadOnly: true } },
      }),
    )

    const approvePromise = service.approveToolCall({
      conversationId: 'conv-approve-bashro',
      toolCallId: 'call-1',
    })

    await waitForRuntimeCount(2)
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'yolo_local__bash', bashReadOnly: true }),
    )

    runtimeInstances[1].resolveRun()
    expect(await approvePromise).toBe(true)
    firstRuntime.resolveRun()
    await runPromise
  })

  it('approveToolCall ignores allowForConversation when the persisted approvalPolicy is always-require-user', async () => {
    const service = new AgentService()
    const userMessage = makeUserMessage('u1', 'dispatch once')
    const allowToolForConversation = jest.fn()
    const callTool = jest.fn().mockResolvedValue({
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: 'ok' },
    })
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const runPromise = service.run({
      conversationId: 'conv-approve-locked',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: {
        conversationId: 'conv-approve-locked',
        messages: [userMessage],
        model: { id: 'model-1' },
        mcpManager: { callTool, allowToolForConversation },
      } as unknown as AgentRuntimeRunInput,
    })
    const firstRuntime = runtimeInstances[0]
    firstRuntime.emitSnapshot(
      makeAssistantToolMessages({
        userMessage,
        responseStatus: ToolCallResponseStatus.PendingApproval,
        toolName: 'module-mode-learning-chat__start_course_generation',
        requestMetadata: { approvalPolicy: 'always-require-user' },
      }),
    )

    const approvePromise = service.approveToolCall({
      conversationId: 'conv-approve-locked',
      toolCallId: 'call-1',
      allowForConversation: true,
    })

    await waitForRuntimeCount(2)
    expect(allowToolForConversation).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()

    runtimeInstances[1].resolveRun()
    expect(await approvePromise).toBe(true)
    firstRuntime.resolveRun()
    await runPromise
    warnSpy.mockRestore()
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
    const drained = captured?.drainPendingUserMessages?.()
    expect(drained).toEqual({
      messages: [queued],
      sourceUserMessageId: queued.id,
    })
    expect(service.peekPendingUserMessages('conv-drain')).toEqual([])
    expect(
      service.getConversationRunSummary('conv-drain').anchorMessageId,
    ).toBe(queued.id)

    runtime.resolveRun()
    await runPromise
  })

  it('preserves prior conversation history after a queued message is drained', async () => {
    const service = new AgentService()
    const priorUser = makeUserMessage('u0', 'earlier question')
    const priorAssistant: ChatMessage = {
      role: 'assistant',
      id: 'a0',
      content: 'earlier answer',
      metadata: { generationState: 'completed' },
    }
    const currentUser = makeUserMessage('u1', 'current task')
    const runPromise = service.run({
      conversationId: 'conv-drain-history',
      loopConfig: {
        enableTools: true,
        maxAutoIterations: 100,
        includeBuiltinTools: true,
      },
      input: buildBaseRunInput('conv-drain-history', [
        priorUser,
        priorAssistant,
        currentUser,
      ]),
    })
    const runtime = runtimeInstances[0]
    const currentAssistant: ChatMessage = {
      role: 'assistant',
      id: 'a1',
      content: 'working',
      metadata: { generationState: 'completed' },
    }
    runtime.emitSnapshot([currentAssistant])

    const queued = makeUserMessage('u2', 'continue')
    expect(service.enqueueUserMessage('conv-drain-history', queued)).toBe(
      'enqueued',
    )
    expect(runtime.getRunInput()?.drainPendingUserMessages?.()).toMatchObject({
      messages: [queued],
    })

    // NativeAgentRuntime publishes only its run-local tail here.
    runtime.emitSnapshot([currentAssistant, queued])

    expect(
      service
        .getState('conv-drain-history')
        .messages.map((message) => message.id),
    ).toEqual(['u0', 'a0', 'u1', 'a1', 'u2'])
    expect(
      service.getConversationRunSummary('conv-drain-history').anchorMessageId,
    ).toBe('u2')

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

    expect(secondInput?.drainPendingUserMessages?.()).toEqual({
      messages: [queued],
      sourceUserMessageId: queued.id,
    })
    expect(service.getConversationRunSummary('conv-cont').anchorMessageId).toBe(
      queued.id,
    )

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
      reason: 'The user rejected this tool call.',
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
