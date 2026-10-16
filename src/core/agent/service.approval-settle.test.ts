import type { ChatUserMessage } from '../../types/chat'
import { createCompleteToolCallArguments } from '../../types/tool-call.types'
import { executeSingleTurn } from '../ai/single-turn'
import { ProviderRequestError } from '../llm/providerErrors'

jest.mock('../ai/single-turn', () => ({
  executeSingleTurn: jest.fn(),
}))

import { AgentSessionService } from './service'
import type { AgentRuntimeRunInput } from './types'

const mockedExecuteSingleTurn = jest.mocked(executeSingleTurn)

const buildUserMessage = (id: string): ChatUserMessage => ({
  role: 'user',
  id,
  content: null,
  promptContent: id,
  mentionables: [],
})

const flushQueuedContinuation = async () => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * The first LLM turn requests `toolNames` (all of which need approval); every
 * later turn fails with a provider error, as in an overloaded provider.
 */
const setUp = (
  toolNames: string[],
  onFirstTurn?: (service: AgentSessionService) => void,
) => {
  const service = new AgentSessionService()
  let llmCalls = 0
  mockedExecuteSingleTurn.mockReset()
  mockedExecuteSingleTurn.mockImplementation(async () => {
    llmCalls += 1
    if (llmCalls > 1) {
      throw new ProviderRequestError('minimax', 529, 'overloaded', null)
    }
    onFirstTurn?.(service)
    return {
      content: '',
      toolCalls: toolNames.map((name) => ({
        id: `call-${name}`,
        name,
        arguments: createCompleteToolCallArguments({ value: {} }),
      })),
    } as never
  })

  const mcpManager = {
    isToolExecutionAllowed: jest.fn().mockReturnValue(false),
    isExecutionAllowanceGranted: jest.fn().mockReturnValue(true),
    getJsSandboxSettings: jest.fn().mockReturnValue({}),
    listAvailableTools: jest.fn().mockResolvedValue(
      toolNames.map((name) => ({
        name,
        description: name,
        inputSchema: { type: 'object', properties: {} },
      })),
    ),
    getSettingsSnapshot: () => ({
      mcp: { servers: [], discoveredCatalogs: {} },
    }),
    callTool: jest.fn().mockResolvedValue({
      status: 'success',
      data: { type: 'text', text: 'exit_code 0' },
    }),
    abortToolCall: jest.fn(),
    allowToolForConversation: jest.fn(),
  }

  const run = () =>
    service.run({
      conversationId: 'conv',
      loopConfig: { maxAutoIterations: 10 },
      input: {
        providerClient: {
          resolveResponseExecutionMode: () => 'incremental-streaming',
        },
        model: { id: 'm', model: 'm', providerId: 'minimax' },
        messages: [buildUserMessage('u1')],
        conversationId: 'conv',
        requestContextBuilder: {
          generateRequestMessages: jest
            .fn()
            .mockResolvedValue([{ role: 'user', content: 'u1' }]),
        },
        mcpManager,
        allowedToolNames: toolNames,
        toolPreferences: Object.fromEntries(
          toolNames.map((name) => [name, { enabled: true }]),
        ),
        toolServerPreferences: { server: { disclosureMode: 'always' } },
        abortSignal: new AbortController().signal,
      } as unknown as AgentRuntimeRunInput,
    })

  return { service, run, getLlmCalls: () => llmCalls }
}

describe('AgentSessionService approval settling', () => {
  it('leaves the conversation idle after approving one call and rejecting its sibling', async () => {
    const { service, run } = setUp(['server__a', 'server__b'])
    await run()

    await service.approveToolCall({
      conversationId: 'conv',
      toolCallId: 'call-server__a',
    })
    service.rejectToolCall({
      conversationId: 'conv',
      toolCallId: 'call-server__b',
    })

    const summary = service.getConversationRunSummary('conv')
    expect(service.getState('conv').status).not.toBe('running')
    expect(summary.isActive).toBe(false)
  })

  it('hands queued messages back instead of continuing past a pending approval', async () => {
    const restored: ChatUserMessage[][] = []
    const { service, run, getLlmCalls } = setUp(['server__a'], (svc) => {
      svc.enqueueUserMessage('conv', buildUserMessage('u-queued'))
    })
    service.subscribeToAbortedQueuedMessages((_conversationId, messages) => {
      restored.push(messages)
    })

    await run()
    await flushQueuedContinuation()

    expect(getLlmCalls()).toBe(1)
    expect(restored.map((batch) => batch.map((m) => m.id))).toEqual([
      ['u-queued'],
    ])
    expect(service.peekPendingUserMessages('conv')).toEqual([])

    // The approved result continues the turn; the provider then fails, and
    // the conversation must settle instead of staying "running".
    await expect(
      service.approveToolCall({
        conversationId: 'conv',
        toolCallId: 'call-server__a',
      }),
    ).rejects.toBeInstanceOf(ProviderRequestError)
    expect(getLlmCalls()).toBe(2)
    expect(service.getState('conv').status).toBe('error')
    expect(service.getConversationRunSummary('conv').isActive).toBe(false)
  })
})
