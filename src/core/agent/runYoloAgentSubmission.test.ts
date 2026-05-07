import type { AgentRuntimeLoopConfig, AgentRuntimeRunInput } from './types'
import { runYoloAgentSubmission } from './runYoloAgentSubmission'
import type { RunYoloAgentInput } from '../../runtime/yoloRuntime.types'

describe('runYoloAgentSubmission', () => {
  it('primes conversation state and executes a standard single run', async () => {
    const replaceConversationMessages = jest.fn()
    const run = jest.fn().mockResolvedValue(undefined)
    const buildAgentRuntimeInput = jest.fn().mockResolvedValue({
      input: { conversationId: 'conv-1' } as AgentRuntimeRunInput,
      loopConfig: { enableTools: true, includeBuiltinTools: true } as AgentRuntimeLoopConfig,
      selectedAssistant: null,
    })

    await runYoloAgentSubmission({
      input: {
        conversationId: 'conv-1',
        messages: [{ role: 'user', content: 'request' } as any],
        conversationMessages: [{ role: 'user', content: 'visible' } as any],
        compaction: [{ summary: 's1' }] as any,
      },
      buildAgentRuntimeInput,
      replaceConversationMessages,
      runAgentService: run,
    })

    expect(replaceConversationMessages).toHaveBeenCalledWith(
      'conv-1',
      [{ role: 'user', content: 'visible' }],
      [{ summary: 's1' }],
      { persistState: true },
    )
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('fans out multi-model user submissions into branch runs', async () => {
    const replaceConversationMessages = jest.fn()
    const run = jest.fn().mockResolvedValue(undefined)
    const buildAgentRuntimeInput = jest
      .fn<
        Promise<{
          input: AgentRuntimeRunInput
          loopConfig: AgentRuntimeLoopConfig
          selectedAssistant: null
        }>,
        [RunYoloAgentInput]
      >()
      .mockImplementation(async (input) => ({
        input: {
          conversationId: input.conversationId,
          model: {
            id: input.modelId,
            name: input.modelId === 'model-a' ? 'Model A' : 'Model B',
          },
          branchId: input.branchTarget?.branchId,
          sourceUserMessageId: input.branchTarget?.sourceUserMessageId,
          branchLabel: input.branchTarget?.branchLabel,
        } as any,
        loopConfig: {
          enableTools: true,
          includeBuiltinTools: true,
        } as AgentRuntimeLoopConfig,
        selectedAssistant: null,
      }))

    await runYoloAgentSubmission({
      input: {
        conversationId: 'conv-2',
        messages: [{ role: 'user', id: 'user-1', content: 'visible' } as any],
        requestMessages: [{ role: 'user', id: 'user-1', content: 'request' } as any],
        conversationMessages: [{ role: 'user', id: 'user-1', content: 'visible' } as any],
        modelIds: ['model-a', 'model-b'],
      },
      buildAgentRuntimeInput,
      replaceConversationMessages,
      runAgentService: run,
    })

    expect(replaceConversationMessages).toHaveBeenCalledWith(
      'conv-2',
      [{ role: 'user', id: 'user-1', content: 'visible' }],
      [],
      { persistState: true },
    )
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        conversationId: 'conv-2',
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
        conversationId: 'conv-2',
        persistState: true,
        input: expect.objectContaining({
          branchId: 'user-1:model-b',
          sourceUserMessageId: 'user-1',
          branchLabel: 'Model B',
        }),
      }),
    )
  })

  it('keeps explicit branch-target submissions as a single runtime run', async () => {
    const replaceConversationMessages = jest.fn()
    const run = jest.fn().mockResolvedValue(undefined)
    const buildAgentRuntimeInput = jest.fn().mockResolvedValue({
      input: {
        conversationId: 'conv-branch',
        branchId: 'branch-a',
        sourceUserMessageId: 'user-1',
      } as AgentRuntimeRunInput,
      loopConfig: { enableTools: true, includeBuiltinTools: true } as AgentRuntimeLoopConfig,
      selectedAssistant: null,
    })

    await runYoloAgentSubmission({
      input: {
        conversationId: 'conv-branch',
        messages: [{ role: 'user', id: 'user-1', content: 'visible' } as any],
        requestMessages: [{ role: 'user', id: 'user-1', content: 'request' } as any],
        branchTarget: {
          branchId: 'branch-a',
          sourceUserMessageId: 'user-1',
          branchLabel: 'Branch A',
        },
        modelIds: ['model-a', 'model-b'],
      },
      buildAgentRuntimeInput,
      replaceConversationMessages,
      runAgentService: run,
    })

    expect(buildAgentRuntimeInput).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-branch',
        persistState: true,
      }),
    )
  })

  it('does not fan out multi-model submissions when the last request message is not a user message', async () => {
    const replaceConversationMessages = jest.fn()
    const run = jest.fn().mockResolvedValue(undefined)
    const buildAgentRuntimeInput = jest.fn().mockResolvedValue({
      input: { conversationId: 'conv-non-user' } as AgentRuntimeRunInput,
      loopConfig: { enableTools: true, includeBuiltinTools: true } as AgentRuntimeLoopConfig,
      selectedAssistant: null,
    })

    await runYoloAgentSubmission({
      input: {
        conversationId: 'conv-non-user',
        messages: [{ role: 'assistant', id: 'assistant-1', content: 'visible' } as any],
        requestMessages: [{ role: 'assistant', id: 'assistant-1', content: 'request' } as any],
        modelIds: ['model-a', 'model-b'],
      },
      buildAgentRuntimeInput,
      replaceConversationMessages,
      runAgentService: run,
    })

    expect(buildAgentRuntimeInput).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
