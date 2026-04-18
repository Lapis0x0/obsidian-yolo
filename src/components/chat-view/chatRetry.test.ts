import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'

import {
  buildRetrySubmissionMessages,
  getDisplayedAssistantToolMessages,
} from './chatRetry'

describe('chatRetry', () => {
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
