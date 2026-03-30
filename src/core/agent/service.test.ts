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
})
