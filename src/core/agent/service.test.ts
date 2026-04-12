import { ChatMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { AgentService } from './service'

type MockRuntimeInstance = {
  abort: jest.Mock
  run: jest.Mock<Promise<void>, []>
  subscribe: jest.Mock<
    () => void,
    [(snapshot: { messages: ChatMessage[] }) => void]
  >
  emitSnapshot: (messages: ChatMessage[]) => void
  resolveRun: () => void
}

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
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve
    })

    const instance: MockRuntimeInstance = {
      abort: jest.fn(),
      run: jest.fn(() => runPromise),
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
})
