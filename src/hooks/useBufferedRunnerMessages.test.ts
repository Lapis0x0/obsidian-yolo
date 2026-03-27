import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../types/chat'

import {
  mergeRunnerMessagesFromAnchor,
  reconcileAssistantGenerationState,
} from './useBufferedRunnerMessages'

const createUserMessage = (id: string): ChatUserMessage => ({
  role: 'user',
  id,
  content: null,
  promptContent: null,
  mentionables: [],
})

const createAssistantMessage = (
  id: string,
  content: string,
  generationState?: 'streaming' | 'completed' | 'aborted' | 'error',
): ChatAssistantMessage => ({
  role: 'assistant',
  id,
  content,
  metadata: generationState ? { generationState } : undefined,
})

const createToolMessage = (id: string): ChatToolMessage => ({
  role: 'tool',
  id,
  toolCalls: [],
})

describe('mergeRunnerMessagesFromAnchor', () => {
  it('appends incremental runner messages after the anchor when response omits it', () => {
    const baseMessages: ChatMessage[] = [
      createUserMessage('user-1'),
      createAssistantMessage('assistant-old', 'old'),
      createUserMessage('user-2'),
    ]
    const responseMessages: ChatMessage[] = [
      createAssistantMessage('assistant-2', 'new answer'),
    ]

    expect(
      mergeRunnerMessagesFromAnchor(baseMessages, 'user-2', responseMessages),
    ).toEqual([
      createUserMessage('user-1'),
      createAssistantMessage('assistant-old', 'old'),
      createUserMessage('user-2'),
      createAssistantMessage('assistant-2', 'new answer'),
    ])
  })

  it('does not duplicate the anchor when runner response already includes it', () => {
    const baseMessages: ChatMessage[] = [
      createUserMessage('user-1'),
      createUserMessage('user-2'),
    ]
    const responseMessages: ChatMessage[] = [
      createUserMessage('user-2'),
      createAssistantMessage('assistant-2', 'new answer'),
    ]

    expect(
      mergeRunnerMessagesFromAnchor(baseMessages, 'user-2', responseMessages),
    ).toEqual([
      createUserMessage('user-1'),
      createUserMessage('user-2'),
      createAssistantMessage('assistant-2', 'new answer'),
    ])
  })

  it('replaces stale assistant and tool messages after the anchor', () => {
    const baseMessages: ChatMessage[] = [
      createUserMessage('user-1'),
      createUserMessage('user-2'),
      createAssistantMessage('assistant-stale', 'stale answer'),
      createToolMessage('tool-stale'),
    ]
    const responseMessages: ChatMessage[] = [
      createUserMessage('user-2'),
      createAssistantMessage('assistant-fresh', 'fresh answer'),
      createToolMessage('tool-fresh'),
    ]

    expect(
      mergeRunnerMessagesFromAnchor(baseMessages, 'user-2', responseMessages),
    ).toEqual([
      createUserMessage('user-1'),
      createUserMessage('user-2'),
      createAssistantMessage('assistant-fresh', 'fresh answer'),
      createToolMessage('tool-fresh'),
    ])
  })
})

describe('reconcileAssistantGenerationState', () => {
  it('preserves aborted state when a later snapshot still marks the assistant as streaming', () => {
    const previousMessages: ChatMessage[] = [
      createUserMessage('user-1'),
      createAssistantMessage('assistant-1', 'partial', 'aborted'),
    ]
    const nextMessages: ChatMessage[] = [
      createUserMessage('user-1'),
      createAssistantMessage('assistant-1', 'partial', 'streaming'),
    ]

    expect(
      reconcileAssistantGenerationState(previousMessages, nextMessages),
    ).toEqual([
      createUserMessage('user-1'),
      createAssistantMessage('assistant-1', 'partial', 'aborted'),
    ])
  })
})
