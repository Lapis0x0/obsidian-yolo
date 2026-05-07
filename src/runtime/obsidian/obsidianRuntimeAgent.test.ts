import { createObsidianRuntimeAgent } from './obsidianRuntimeAgent'
import { buildAgentRuntimeInput } from '../../core/agent/buildAgentRuntimeInput'

jest.mock('../../core/agent/buildAgentRuntimeInput', () => ({
  buildAgentRuntimeInput: jest.fn(),
}))

describe('createObsidianRuntimeAgent', () => {
  const mockBuildAgentRuntimeInput =
    buildAgentRuntimeInput as jest.MockedFunction<typeof buildAgentRuntimeInput>

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses conversationMessages and compaction when priming conversation state', async () => {
    const replaceConversationMessages = jest.fn()
    const run = jest.fn().mockResolvedValue(undefined)

    mockBuildAgentRuntimeInput.mockResolvedValue({
      input: { conversationId: 'conv-1' } as any,
      loopConfig: { enableTools: true, includeBuiltinTools: true } as any,
      selectedAssistant: null,
    })

    const runtimeAgent = createObsidianRuntimeAgent({
      getAgentService: () =>
        ({
          replaceConversationMessages,
          run,
          subscribe: jest.fn(),
          getState: jest.fn(),
          getConversationRunSummary: jest.fn(),
          approveToolCall: jest.fn(),
          rejectToolCall: jest.fn(),
          abortToolCall: jest.fn(),
          isRunning: jest.fn(),
          subscribeToRunSummaries: jest.fn(),
          subscribeToPendingExternalAgentResults: jest.fn(),
          abortConversation: jest.fn(),
        }) as any,
      buildAgentRuntimeInput: jest.fn(),
    } as any)

    await runtimeAgent.run({
      conversationId: 'conv-1',
      messages: [{ role: 'user', content: 'request' } as any],
      conversationMessages: [{ role: 'user', content: 'visible' } as any],
      compaction: [{ summary: 's1' }] as any,
    })

    expect(replaceConversationMessages).toHaveBeenCalledWith(
      'conv-1',
      [{ role: 'user', content: 'visible' }],
      [{ summary: 's1' }],
      { persistState: true },
    )
  })

  it('passes requestMessages, reasoningLevel, and branch target data into the runtime builder', async () => {
    const replaceConversationMessages = jest.fn()
    const run = jest.fn().mockResolvedValue(undefined)

    mockBuildAgentRuntimeInput.mockResolvedValue({
      input: { conversationId: 'conv-2' } as any,
      loopConfig: { enableTools: true, includeBuiltinTools: true } as any,
      selectedAssistant: null,
    })

    const runtimeAgent = createObsidianRuntimeAgent({
      getAgentService: () =>
        ({
          replaceConversationMessages,
          run,
          subscribe: jest.fn(),
          getState: jest.fn(),
          getConversationRunSummary: jest.fn(),
          approveToolCall: jest.fn(),
          rejectToolCall: jest.fn(),
          abortToolCall: jest.fn(),
          isRunning: jest.fn(),
          subscribeToRunSummaries: jest.fn(),
          subscribeToPendingExternalAgentResults: jest.fn(),
          abortConversation: jest.fn(),
        }) as any,
      buildAgentRuntimeInput: jest.fn(),
    } as any)

    const requestMessages = [{ role: 'user', content: 'request' }] as any
    const conversationMessages = [{ role: 'user', content: 'visible' }] as any

    await runtimeAgent.run({
      conversationId: 'conv-2',
      messages: conversationMessages,
      requestMessages,
      conversationMessages,
      reasoningLevel: 'high' as any,
      modelId: 'model-a',
      branchTarget: {
        branchId: 'branch-a',
        sourceUserMessageId: 'user-1',
        branchLabel: 'Branch A',
      },
    })

    expect(mockBuildAgentRuntimeInput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: 'conv-2',
        messages: conversationMessages,
        requestMessages,
        reasoningLevel: 'high',
        modelId: 'model-a',
        branchTarget: {
          branchId: 'branch-a',
          sourceUserMessageId: 'user-1',
          branchLabel: 'Branch A',
        },
      }),
    )
  })

  it('fans out multi-model user submissions into branch runs in the runtime layer', async () => {
    const replaceConversationMessages = jest.fn()
    const run = jest.fn().mockResolvedValue(undefined)

    mockBuildAgentRuntimeInput
      .mockResolvedValueOnce({
        input: {
          conversationId: 'conv-3',
          model: { id: 'model-a', name: 'Model A' },
          branchId: 'user-1:model-a',
          sourceUserMessageId: 'user-1',
        } as any,
        loopConfig: { enableTools: true, includeBuiltinTools: true } as any,
        selectedAssistant: null,
      })
      .mockResolvedValueOnce({
        input: {
          conversationId: 'conv-3',
          model: { id: 'model-b', name: 'Model B' },
          branchId: 'user-1:model-b',
          sourceUserMessageId: 'user-1',
        } as any,
        loopConfig: { enableTools: true, includeBuiltinTools: true } as any,
        selectedAssistant: null,
      })

    const runtimeAgent = createObsidianRuntimeAgent({
      getAgentService: () =>
        ({
          replaceConversationMessages,
          run,
          subscribe: jest.fn(),
          getState: jest.fn(),
          getConversationRunSummary: jest.fn(),
          approveToolCall: jest.fn(),
          rejectToolCall: jest.fn(),
          abortToolCall: jest.fn(),
          isRunning: jest.fn(),
          subscribeToRunSummaries: jest.fn(),
          subscribeToPendingExternalAgentResults: jest.fn(),
          abortConversation: jest.fn(),
        }) as any,
    } as any)

    const messages = [{ role: 'user', id: 'user-1', content: 'visible' }] as any
    const requestMessages = [{ role: 'user', id: 'user-1', content: 'request' }] as any

    await runtimeAgent.run({
      conversationId: 'conv-3',
      messages,
      requestMessages,
      conversationMessages: messages,
      modelIds: ['model-a', 'model-b'],
    })

    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        conversationId: 'conv-3',
        persistState: true,
        input: expect.objectContaining({
          branchId: 'user-1:model-a',
          sourceUserMessageId: 'user-1',
          branchLabel: 'Model A',
        }),
      }),
    )
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        conversationId: 'conv-3',
        persistState: true,
        input: expect.objectContaining({
          branchId: 'user-1:model-b',
          sourceUserMessageId: 'user-1',
          branchLabel: 'Model B',
        }),
      }),
    )
  })
})
