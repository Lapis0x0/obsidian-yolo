import type { ChatAssistantMessage, ChatMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { executeSingleTurn } from '../ai/single-turn'

jest.mock('../ai/single-turn', () => ({
  executeSingleTurn: jest.fn(),
}))

import {
  ASSISTANT_CONTINUATION_PROMPT,
  NativeAgentRuntime,
} from './native-runtime'
import { shouldProceedToToolPhase } from './tool-phase'
import type { AgentRuntimeLoopConfig, AgentRuntimeRunInput } from './types'

const mockedExecuteSingleTurn = jest.mocked(executeSingleTurn)

describe('shouldProceedToToolPhase', () => {
  it('returns true when tool call requests exist even if model terminated', () => {
    const turnResult = {
      toolCallRequests: [{ id: 'call-1' }],
      modelTerminated: true,
    }
    const result = shouldProceedToToolPhase(turnResult)

    expect(result).toBe(true)
  })

  it('returns false when tool call requests are empty', () => {
    const turnResult = {
      toolCallRequests: [],
      modelTerminated: false,
    }
    const result = shouldProceedToToolPhase(turnResult)

    expect(result).toBe(false)
  })
})

describe('NativeAgentRuntime tool-call helpers', () => {
  const makeLoopConfig = (): AgentRuntimeLoopConfig => ({
    enableTools: true,
    includeBuiltinTools: true,
    maxAutoIterations: 10,
  })

  const makeToolMessage = (
    toolCallId: string,
    status: ToolCallResponseStatus = ToolCallResponseStatus.PendingApproval,
  ): ChatMessage => ({
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
        response:
          status === ToolCallResponseStatus.Success
            ? {
                status,
                data: { type: 'text', text: 'ok' },
              }
            : status === ToolCallResponseStatus.Error
              ? { status, error: 'boom' }
              : { status },
      },
    ],
  })

  // Cast to a structurally-equivalent shape to seed the runtime's private
  // `messages` for unit testing approval-routing helpers in isolation.
  // Production code never touches the runtime this way; everything goes
  // through `run()`.
  const seedMessages = (
    runtime: NativeAgentRuntime,
    messages: ChatMessage[],
  ): void => {
    ;(runtime as unknown as { messages: ChatMessage[] }).messages = messages
  }

  it('findToolCall locates a tool call by id', () => {
    const runtime = new NativeAgentRuntime(makeLoopConfig())
    seedMessages(runtime, [makeToolMessage('call-1')])

    const located = runtime.findToolCall('call-1')
    expect(located).not.toBeNull()
    expect(located?.toolCall.request.id).toBe('call-1')
    expect(located?.toolCall.response.status).toBe(
      ToolCallResponseStatus.PendingApproval,
    )
  })

  it('findToolCall returns null when no message contains the id', () => {
    const runtime = new NativeAgentRuntime(makeLoopConfig())
    seedMessages(runtime, [makeToolMessage('call-1')])

    expect(runtime.findToolCall('missing')).toBeNull()
  })

  it('setToolCallResponse patches the matching call and notifies subscribers', () => {
    const runtime = new NativeAgentRuntime(makeLoopConfig())
    seedMessages(runtime, [makeToolMessage('call-1')])

    const subscriber = jest.fn()
    runtime.subscribe(subscriber)

    const patched = runtime.setToolCallResponse('call-1', {
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: 'done' },
    })

    expect(patched).toBe(true)
    expect(subscriber).toHaveBeenCalledTimes(1)

    const after = runtime.findToolCall('call-1')
    expect(after?.toolCall.response.status).toBe(ToolCallResponseStatus.Success)
  })

  it('setToolCallResponse returns false when no message contains the id', () => {
    const runtime = new NativeAgentRuntime(makeLoopConfig())
    seedMessages(runtime, [makeToolMessage('call-1')])

    const subscriber = jest.fn()
    runtime.subscribe(subscriber)

    const patched = runtime.setToolCallResponse('missing', {
      status: ToolCallResponseStatus.Rejected,
    })

    expect(patched).toBe(false)
    expect(subscriber).not.toHaveBeenCalled()
  })
})

describe('NativeAgentRuntime assistant continuation', () => {
  beforeEach(() => {
    mockedExecuteSingleTurn.mockReset()
  })

  it('sanitizes the interrupted tool call and sends one transient continuation prompt', async () => {
    const interruptedAssistant: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-1',
      content: 'partial',
      toolCallRequests: [
        {
          id: 'partial-tool',
          name: 'fs_read',
          arguments: undefined,
        },
      ],
      metadata: {
        generationState: 'error',
        errorMessage: 'Premature close',
        sourceUserMessageId: 'user-1',
      },
    }
    const messages: ChatMessage[] = [
      {
        role: 'user',
        id: 'user-1',
        content: null,
        promptContent: 'question',
        mentionables: [],
      },
      interruptedAssistant,
    ]
    const generateRequestMessages = jest.fn().mockResolvedValue([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'partial' },
    ])
    mockedExecuteSingleTurn.mockResolvedValue({
      content: ' continuation',
      reasoning: undefined,
      annotations: undefined,
      usage: undefined,
      providerMetadata: undefined,
      toolCalls: [],
    })

    const runtime = new NativeAgentRuntime({
      enableTools: false,
      includeBuiltinTools: false,
      maxAutoIterations: 1,
    })
    const snapshots: ChatMessage[][] = []
    runtime.subscribe((snapshot) => snapshots.push(snapshot.messages))

    await runtime.run({
      providerClient: {
        resolveResponseExecutionMode: () => 'incremental-streaming',
      },
      model: {
        id: 'model-1',
        model: 'model-1',
        providerId: 'provider-1',
      },
      messages,
      requestMessages: messages,
      conversationId: 'conversation-1',
      sourceUserMessageId: 'user-1',
      continueAssistantMessageId: interruptedAssistant.id,
      requestContextBuilder: { generateRequestMessages },
      mcpManager: {
        getJsSandboxSettings: () => ({}),
        getSettingsSnapshot: () => ({}),
      },
    } as unknown as AgentRuntimeRunInput)

    expect(generateRequestMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: interruptedAssistant.id,
            toolCallRequests: undefined,
          }),
        ]),
      }),
    )
    expect(mockedExecuteSingleTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          messages: expect.arrayContaining([
            {
              role: 'user',
              content: ASSISTANT_CONTINUATION_PROMPT,
            },
          ]),
        }),
      }),
    )
    expect(snapshots.at(-1)).toEqual([
      expect.objectContaining({
        id: interruptedAssistant.id,
        content: 'partial continuation',
        toolCallRequests: undefined,
        metadata: expect.objectContaining({ generationState: 'completed' }),
      }),
    ])
  })
})
