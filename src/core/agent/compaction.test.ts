import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import type { ChatMessage } from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'

import {
  getLatestAssistantContextUsage,
  getCompactionSummarySourceMessages,
  shouldTriggerAutoContextCompaction,
} from './compaction'

describe('compaction summary source selection', () => {
  it('keeps the full visible history for manual compaction summaries', () => {
    const emptyArgs = createCompleteToolCallArguments({ value: {} })
    const messages: ChatMessage[] = [
      {
        role: 'user' as const,
        id: 'user-1',
        content: null,
        promptContent: 'old prompt',
        mentionables: [],
      },
      {
        role: 'assistant' as const,
        id: 'assistant-tools',
        content: 'checking files',
        toolCallRequests: [
          {
            id: 'compact-1',
            name: 'yolo_local__context_compact',
            arguments: emptyArgs,
          },
        ],
      },
      {
        role: 'tool' as const,
        id: 'tool-compact',
        toolCalls: [
          {
            request: {
              id: 'compact-1',
              name: 'yolo_local__context_compact',
              arguments: emptyArgs,
            },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text' as const,
                text: JSON.stringify({
                  tool: 'context_compact',
                  toolCallId: 'compact-1',
                  operation: 'compact_restart',
                }),
              },
            },
          },
        ],
      },
      {
        role: 'assistant' as const,
        id: 'assistant-after',
        content: 'recent answer after compact',
      },
    ]

    expect(
      getCompactionSummarySourceMessages(messages, {
        retainLatestToolBoundary: false,
      }),
    ).toEqual(messages)
  })
})

const baseAutoOptions = {
  autoContextCompactionEnabled: true,
  autoContextCompactionThresholdMode: 'tokens' as const,
  autoContextCompactionThresholdTokens: 100,
  autoContextCompactionThresholdRatio: 0.8,
}

const userMsg = (id: string): ChatMessage => ({
  role: 'user',
  id,
  content: null,
  promptContent: 'hi',
  mentionables: [],
})

const assistantMsg = (
  id: string,
  usage?: { prompt_tokens: number },
  model?: Pick<ChatModel, 'maxContextTokens'>,
): ChatMessage => ({
  role: 'assistant',
  id,
  content: 'ok',
  metadata: usage
    ? {
        usage: {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: 0,
          total_tokens: usage.prompt_tokens,
        },
        model: model
          ? ({
              providerId: 'provider',
              id: 'model-id',
              model: 'model-name',
              maxContextTokens: model.maxContextTokens,
            } satisfies ChatModel)
          : undefined,
      }
    : undefined,
})

describe('shouldTriggerAutoContextCompaction', () => {
  it('returns false when disabled', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [userMsg('u1'), assistantMsg('a1', { prompt_tokens: 200 })],
        chatOptions: { ...baseAutoOptions, autoContextCompactionEnabled: false },
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('tokens mode: below threshold', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [userMsg('u1'), assistantMsg('a1', { prompt_tokens: 50 })],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('tokens mode: at threshold', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [userMsg('u1'), assistantMsg('a1', { prompt_tokens: 100 })],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(true)
  })

  it('ratio mode: below ratio', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 70 }, { maxContextTokens: 100 }),
        ],
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionThresholdMode: 'ratio',
          autoContextCompactionThresholdRatio: 0.8,
        },
        maxContextTokens: 100,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('ratio mode: at ratio', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 80 }, { maxContextTokens: 100 }),
        ],
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionThresholdMode: 'ratio',
          autoContextCompactionThresholdRatio: 0.8,
        },
        maxContextTokens: 100,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(true)
  })

  it('ratio mode: missing maxContextTokens', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [userMsg('u1'), assistantMsg('a1', { prompt_tokens: 99 })],
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionThresholdMode: 'ratio',
        },
        maxContextTokens: undefined,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('ratio mode: uses the same maxContextTokens source as the header ring', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 800 }, { maxContextTokens: 1000 }),
        ],
        chatOptions: {
          ...baseAutoOptions,
          autoContextCompactionThresholdMode: 'ratio',
          autoContextCompactionThresholdRatio: 0.8,
        },
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(true)
  })

  it('still triggers when the latest visible usage comes from an earlier assistant message', () => {
    const emptyArgs = createCompleteToolCallArguments({ value: {} })
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [
          userMsg('u1'),
          assistantMsg('a1', { prompt_tokens: 200 }),
          {
            role: 'tool',
            id: 't1',
            toolCalls: [
              {
                request: {
                  id: 'x',
                  name: 'y',
                  arguments: emptyArgs,
                },
                response: {
                  status: ToolCallResponseStatus.Success,
                  data: { type: 'text', text: '{}' },
                },
              },
            ],
          },
        ],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(true)
  })

  it('assistant missing prompt_tokens', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [userMsg('u1'), assistantMsg('a1')],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })

  it('run active', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [userMsg('u1'), assistantMsg('a1', { prompt_tokens: 200 })],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [],
        isConversationRunActive: true,
      }),
    ).toBe(false)
  })

  it('does not repeat compaction for same assistant anchor', () => {
    expect(
      shouldTriggerAutoContextCompaction({
        previousMessages: [userMsg('u1'), assistantMsg('a1', { prompt_tokens: 200 })],
        chatOptions: baseAutoOptions,
        maxContextTokens: 1000,
        compactionState: [
          {
            anchorMessageId: 'a1',
            summary: 's',
            compactedAt: 1,
          },
        ],
        isConversationRunActive: false,
      }),
    ).toBe(false)
  })
})

describe('getLatestAssistantContextUsage', () => {
  it('matches the header ring data source by using the latest assistant with prompt tokens', () => {
    const contextUsage = getLatestAssistantContextUsage({
      messages: [
        userMsg('u1'),
        assistantMsg('a1', { prompt_tokens: 100 }),
        {
          role: 'tool',
          id: 't1',
          toolCalls: [],
        },
      ],
      maxContextTokens: 1000,
    })

    expect(contextUsage).toEqual(
      expect.objectContaining({
        promptTokens: 100,
        maxContextTokens: 1000,
        ratio: 0.1,
      }),
    )
  })
})
