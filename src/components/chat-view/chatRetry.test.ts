import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'

import {
  buildAssistantErrorContinuation,
  buildRetrySubmissionMessages,
  getDisplayedAssistantToolMessages,
} from './chatRetry'

describe('chatRetry', () => {
  it('builds a continuation payload for the latest partial error', () => {
    const userMessage: ChatUserMessage = {
      role: 'user',
      id: 'user-1',
      content: 'question' as unknown as ChatUserMessage['content'],
      promptContent: null,
      mentionables: [],
    }
    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-1',
      content: 'partial answer',
      metadata: {
        generationState: 'error',
        errorMessage: 'Premature close',
        model: {
          id: 'model-1',
          model: 'model-1',
          providerId: 'provider-1',
        },
      },
    }

    expect(
      buildAssistantErrorContinuation({
        sourceMessages: [userMessage, assistantMessage],
        groupedChatMessages: [userMessage, [assistantMessage]],
        assistantMessageId: assistantMessage.id,
        activeBranchByUserMessageId: new Map(),
      }),
    ).toEqual({
      assistantMessageId: 'assistant-1',
      sourceUserMessageId: 'user-1',
      modelId: 'model-1',
      branchId: undefined,
      branchLabel: undefined,
      inputChatMessages: [userMessage, assistantMessage],
      requestChatMessages: [userMessage, assistantMessage],
    })
  })

  it('rejects a partial error that already has a later user turn', () => {
    const firstUser = {
      role: 'user' as const,
      id: 'user-1',
      content: null,
      promptContent: null,
      mentionables: [],
    }
    const failedAssistant: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-1',
      content: 'partial',
      metadata: {
        generationState: 'error',
        sourceUserMessageId: 'user-1',
        branchModelId: 'model-1',
      },
    }
    const secondUser = {
      ...firstUser,
      id: 'user-2',
    }

    expect(
      buildAssistantErrorContinuation({
        sourceMessages: [firstUser, failedAssistant, secondUser],
        groupedChatMessages: [firstUser, [failedAssistant], secondUser],
        assistantMessageId: failedAssistant.id,
        activeBranchByUserMessageId: new Map(),
      }),
    ).toBeNull()
  })

  it('only continues the active branch at the end of the turn', () => {
    const userMessage: ChatUserMessage = {
      role: 'user',
      id: 'user-1',
      content: null,
      promptContent: null,
      mentionables: [],
    }
    const completedBranch: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-a',
      content: 'complete',
      metadata: {
        generationState: 'completed',
        sourceUserMessageId: 'user-1',
        branchId: 'branch-a',
        branchModelId: 'model-a',
      },
    }
    const failedBranch: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-b',
      content: 'partial',
      metadata: {
        generationState: 'error',
        sourceUserMessageId: 'user-1',
        branchId: 'branch-b',
        branchModelId: 'model-b',
      },
    }
    const group: AssistantToolMessageGroup = [completedBranch, failedBranch]

    expect(
      buildAssistantErrorContinuation({
        sourceMessages: [userMessage, ...group],
        groupedChatMessages: [userMessage, group],
        assistantMessageId: failedBranch.id,
        activeBranchByUserMessageId: new Map([['user-1', 'branch-a']]),
      }),
    ).toBeNull()

    expect(
      buildAssistantErrorContinuation({
        sourceMessages: [userMessage, ...group],
        groupedChatMessages: [userMessage, group],
        assistantMessageId: failedBranch.id,
        activeBranchByUserMessageId: new Map([['user-1', 'branch-b']]),
      })?.modelId,
    ).toBe('model-b')
  })

  it('builds branch retry payload without removing sibling model replies', () => {
    const userMessage: ChatUserMessage = {
      role: 'user',
      id: 'user-1',
      content: 'question' as unknown as ChatUserMessage['content'],
      promptContent: null,
      mentionables: [],
      selectedSkills: [],
      selectedModelIds: [],
    }
    const branchAAssistant: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-a',
      content: 'answer a',
      metadata: {
        generationState: 'completed',
        sourceUserMessageId: 'user-1',
        branchId: 'branch-a',
      },
    }
    const branchATool: ChatToolMessage = {
      role: 'tool',
      id: 'tool-a',
      toolCalls: [],
      metadata: {
        sourceUserMessageId: 'user-1',
        branchId: 'branch-a',
      },
    }
    const branchBAssistant: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-b',
      content: 'answer b',
      metadata: {
        generationState: 'completed',
        sourceUserMessageId: 'user-1',
        branchId: 'branch-b',
        branchModelId: 'deepseek-reasoner',
        branchLabel: 'deepseek-reasoner',
      },
    }

    const group: AssistantToolMessageGroup = [
      branchAAssistant,
      branchATool,
      branchBAssistant,
    ]
    const sourceMessages: ChatMessage[] = [userMessage, ...group]

    const payload = buildRetrySubmissionMessages({
      sourceMessages,
      groupedChatMessages: [userMessage, group],
      targetMessageIds: ['assistant-b'],
      activeBranchByUserMessageId: new Map([['user-1', 'branch-b']]),
    })

    expect(payload).toEqual({
      sourceUserMessageId: 'user-1',
      inputChatMessages: [
        userMessage,
        branchAAssistant,
        branchATool,
        branchBAssistant,
      ],
      requestChatMessages: [userMessage],
      branchTarget: {
        branchId: 'branch-b',
        branchModelId: 'deepseek-reasoner',
        branchLabel: 'deepseek-reasoner',
      },
    })
  })

  it('drops later rounds when retrying a branch from the middle of the conversation', () => {
    const firstUserMessage: ChatUserMessage = {
      role: 'user',
      id: 'user-1',
      content: 'question 1' as unknown as ChatUserMessage['content'],
      promptContent: null,
      mentionables: [],
      selectedSkills: [],
      selectedModelIds: [],
    }
    const branchAAssistant: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-a',
      content: 'answer a',
      metadata: {
        generationState: 'completed',
        sourceUserMessageId: 'user-1',
        branchId: 'branch-a',
      },
    }
    const branchBAssistant: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-b',
      content: 'answer b',
      metadata: {
        generationState: 'completed',
        sourceUserMessageId: 'user-1',
        branchId: 'branch-b',
      },
    }
    const secondUserMessage: ChatUserMessage = {
      role: 'user',
      id: 'user-2',
      content: 'question 2' as unknown as ChatUserMessage['content'],
      promptContent: null,
      mentionables: [],
      selectedSkills: [],
      selectedModelIds: [],
    }
    const secondAssistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-2',
      content: 'answer 2',
      metadata: {
        generationState: 'completed',
        sourceUserMessageId: 'user-2',
      },
    }

    const payload = buildRetrySubmissionMessages({
      sourceMessages: [
        firstUserMessage,
        branchAAssistant,
        branchBAssistant,
        secondUserMessage,
        secondAssistantMessage,
      ],
      groupedChatMessages: [
        firstUserMessage,
        [branchAAssistant, branchBAssistant],
        secondUserMessage,
        [secondAssistantMessage],
      ],
      targetMessageIds: ['assistant-b'],
      activeBranchByUserMessageId: new Map([['user-1', 'branch-b']]),
    })

    expect(payload).toEqual({
      sourceUserMessageId: 'user-1',
      inputChatMessages: [firstUserMessage, branchAAssistant, branchBAssistant],
      requestChatMessages: [firstUserMessage],
      branchTarget: {
        branchId: 'branch-b',
        branchModelId: undefined,
        branchLabel: undefined,
      },
    })
  })

  it('falls back to the first completed branch when no active branch is selected', () => {
    const completedAssistant: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-a',
      content: 'answer a',
      metadata: {
        generationState: 'completed',
        sourceUserMessageId: 'user-1',
        branchId: 'branch-a',
      },
    }
    const streamingAssistant: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-b',
      content: '',
      metadata: {
        generationState: 'streaming',
        sourceUserMessageId: 'user-1',
        branchId: 'branch-b',
      },
    }

    expect(
      getDisplayedAssistantToolMessages(
        [streamingAssistant, completedAssistant],
        null,
      ),
    ).toEqual([completedAssistant])
  })

  it('falls back to the nearest previous user message when metadata is missing', () => {
    const firstUserMessage: ChatUserMessage = {
      role: 'user',
      id: 'user-1',
      content: 'question 1' as unknown as ChatUserMessage['content'],
      promptContent: null,
      mentionables: [],
      selectedSkills: [],
      selectedModelIds: [],
    }
    const secondUserMessage: ChatUserMessage = {
      role: 'user',
      id: 'user-2',
      content: 'question 2' as unknown as ChatUserMessage['content'],
      promptContent: null,
      mentionables: [],
      selectedSkills: [],
      selectedModelIds: [],
    }
    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-2',
      content: 'answer 2',
      metadata: {
        generationState: 'completed',
      },
    }

    const payload = buildRetrySubmissionMessages({
      sourceMessages: [firstUserMessage, secondUserMessage, assistantMessage],
      groupedChatMessages: [
        firstUserMessage,
        secondUserMessage,
        [assistantMessage],
      ],
      targetMessageIds: ['assistant-2'],
      activeBranchByUserMessageId: new Map(),
    })

    expect(payload).toEqual({
      sourceUserMessageId: 'user-2',
      inputChatMessages: [firstUserMessage, secondUserMessage],
      requestChatMessages: [firstUserMessage, secondUserMessage],
    })
  })
})
