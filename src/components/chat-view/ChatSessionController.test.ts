import type {
  AgentConversationState,
  AgentService,
} from '../../core/agent/service'
import { SETTINGS_SCHEMA_VERSION } from '../../settings/schema/migrations'
import { parseYoloSettings } from '../../settings/schema/settings'
import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatUserMessage,
} from '../../types/chat'

import {
  ChatSessionController,
  type ChatSessionControllerDeps,
} from './ChatSessionController'
import { ConversationPreferencesController } from './ConversationPreferencesController'

const userMessage = (
  id: string,
  overrides: Partial<ChatUserMessage> = {},
): ChatUserMessage => ({
  role: 'user',
  id,
  content: null,
  promptContent: null,
  mentionables: [],
  ...overrides,
})

const assistantMessage = (
  id: string,
  overrides: Partial<ChatAssistantMessage> = {},
): ChatAssistantMessage => ({
  role: 'assistant',
  id,
  content: 'hi',
  ...overrides,
})

const emptyState = (conversationId: string): AgentConversationState => ({
  conversationId,
  status: 'idle',
  messages: [],
  compaction: [],
  pendingCompactionAnchorMessageId: null,
})

/** Minimal in-memory stand-in for AgentService's subscribe/getState/replaceConversationMessages
 * trio — enough to exercise ChatSessionController's own subscription without pulling in the
 * real AgentService (which needs an obsidian App/mcp/etc). */
function createMockAgentService() {
  const conversations = new Map<string, AgentConversationState>()
  const subscribers = new Map<
    string,
    Set<(state: AgentConversationState) => void>
  >()

  const getState = (conversationId: string): AgentConversationState =>
    conversations.get(conversationId) ?? emptyState(conversationId)

  const replaceConversationMessages = jest.fn(
    (
      conversationId: string,
      messages: ChatMessage[],
      compaction?: ChatMessage extends never ? never : unknown,
    ) => {
      const next: AgentConversationState = {
        conversationId,
        status: 'idle',
        messages: [...messages],
        compaction: Array.isArray(compaction) ? [...compaction] : [],
        pendingCompactionAnchorMessageId: null,
      }
      conversations.set(conversationId, next)
      subscribers.get(conversationId)?.forEach((callback) => callback(next))
    },
  )

  const subscribe = jest.fn(
    (
      conversationId: string,
      callback: (state: AgentConversationState) => void,
      options?: { emitCurrent?: boolean },
    ) => {
      const set = subscribers.get(conversationId) ?? new Set()
      set.add(callback)
      subscribers.set(conversationId, set)
      if (options?.emitCurrent ?? true) {
        callback(getState(conversationId))
      }
      return () => {
        subscribers.get(conversationId)?.delete(callback)
      }
    },
  )

  const push = (conversationId: string, state: AgentConversationState) => {
    conversations.set(conversationId, state)
    subscribers.get(conversationId)?.forEach((callback) => callback(state))
  }

  return {
    getState,
    replaceConversationMessages,
    subscribe,
    push,
  } as unknown as Pick<
    AgentService,
    'subscribe' | 'getState' | 'replaceConversationMessages'
  > & {
    replaceConversationMessages: jest.Mock
    subscribe: jest.Mock
    push: (conversationId: string, state: AgentConversationState) => void
  }
}

function createPreferencesController(conversationId: string) {
  const settings = parseYoloSettings({ version: SETTINGS_SCHEMA_VERSION })
  return new ConversationPreferencesController(
    conversationId,
    {
      conversationModelId: 'model-1',
      conversationAssistantId: 'assistant-1',
      reasoningLevel: 'off',
      chatMode: 'agent',
      persistedChatMode: 'agent',
      yoloEnabled: false,
      conversationOverrides: null,
    },
    {
      getSettings: () => settings,
      getReasoningLevelForModelId: () => 'off',
      persistPreferredAssistantId: () => undefined,
      persistPreferredChatMode: () => undefined,
    },
  )
}

function createDeps(agentService: ReturnType<typeof createMockAgentService>) {
  const createOrUpdateConversation = jest.fn(async () => undefined)
  const createOrUpdateConversationImmediately = jest.fn(async () => undefined)
  const deleteConversation = jest.fn(async () => undefined)
  const updateConversationTitle = jest.fn(async () => undefined)
  const deps: ChatSessionControllerDeps = {
    getAgentService: () => agentService,
    createOrUpdateConversation,
    createOrUpdateConversationImmediately,
    deleteConversation,
    updateConversationTitle,
    chatModeForSave: (mode) => mode,
  }
  return {
    deps,
    createOrUpdateConversation,
    createOrUpdateConversationImmediately,
    deleteConversation,
    updateConversationTitle,
  }
}

function createController(
  conversationId: string,
  initialMessages: ChatMessage[] = [],
) {
  const agentService = createMockAgentService()
  const preferencesController = createPreferencesController(conversationId)
  const { deps, ...mocks } = createDeps(agentService)
  const controller = new ChatSessionController(
    conversationId,
    {
      chatMessages: initialMessages,
      compactionState: [],
      pendingCompactionAnchorMessageId: null,
      messageModelMap: new Map(),
      messageReasoningMap: new Map(),
      assistantGroupBoundaryMessageIds: [],
      activeBranchByUserMessageId: new Map(),
    },
    preferencesController,
    deps,
  )
  return { controller, preferencesController, agentService, ...mocks }
}

describe('ChatSessionController', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('removes a historical user message, drops its per-message maps entries, and persists', async () => {
    const user1 = userMessage('user-1')
    const assistant1 = assistantMessage('assistant-1')
    const { controller, createOrUpdateConversation } = createController('c1', [
      user1,
      assistant1,
    ])
    controller.setMessageModelMap(new Map([['user-1', 'model-x']]))

    const result = controller.removeHistoricalUserMessage('user-1')

    expect(result.removedMessages).toEqual([user1])
    const snapshot = controller.getSnapshot()
    expect(snapshot.chatMessages).toEqual([assistant1])
    // Untouched message object keeps its reference — the repo-wide invariant.
    expect(snapshot.chatMessages[0]).toBe(assistant1)
    expect(snapshot.messageModelMap.has('user-1')).toBe(false)

    expect(result.outcome.kind).toBe('persisted')
    if (result.outcome.kind === 'persisted') {
      await expect(result.outcome.ok).resolves.toBe(true)
    }
    expect(createOrUpdateConversation).toHaveBeenCalledTimes(1)
  })

  it('deletes the conversation instead of persisting when the last message is removed', async () => {
    const user1 = userMessage('user-1')
    const { controller, deleteConversation, createOrUpdateConversation } =
      createController('c1', [user1])

    const result = controller.removeHistoricalUserMessage('user-1')

    expect(result.outcome).toEqual({ kind: 'deleted' })
    expect(controller.getSnapshot().chatMessages).toEqual([])
    expect(deleteConversation).toHaveBeenCalledWith('c1')
    expect(createOrUpdateConversation).not.toHaveBeenCalled()
  })

  it('updateHistoricalUserMessage never persists and reports whether it found the message', () => {
    const user1 = userMessage('user-1')
    const { controller, createOrUpdateConversation } = createController('c1', [
      user1,
    ])

    const found = controller.updateHistoricalUserMessage(
      'user-1',
      (message) => ({
        ...message,
        mentionables: [],
        promptContent: 'x',
      }),
    )
    expect(found).toBe(true)
    expect(
      (controller.getSnapshot().chatMessages[0] as ChatUserMessage)
        .promptContent,
    ).toBe('x')

    const notFound = controller.updateHistoricalUserMessage('missing', (m) => m)
    expect(notFound).toBe(false)
    expect(createOrUpdateConversation).not.toHaveBeenCalled()
  })

  it('handleAssistantMessageGroupDelete removes the group and persists', async () => {
    const user1 = userMessage('user-1')
    const assistant1 = assistantMessage('assistant-1')
    const { controller, createOrUpdateConversation } = createController('c1', [
      user1,
      assistant1,
    ])

    const result = controller.handleAssistantMessageGroupDelete(['assistant-1'])

    expect(controller.getSnapshot().chatMessages).toEqual([user1])
    expect(result.outcome.kind).toBe('persisted')
    if (result.outcome.kind === 'persisted') {
      await expect(result.outcome.ok).resolves.toBe(true)
    }
    expect(createOrUpdateConversation).toHaveBeenCalledTimes(1)
  })

  it('handleHistoricalUserMessageDelete removes the user turn through the next user message', () => {
    const user1 = userMessage('user-1')
    const assistant1 = assistantMessage('assistant-1')
    const user2 = userMessage('user-2')
    const { controller } = createController('c1', [user1, assistant1, user2])

    const result = controller.handleHistoricalUserMessageDelete('user-1')

    expect(result?.removedMessages).toEqual([user1, assistant1])
    expect(controller.getSnapshot().chatMessages).toEqual([user2])
    // user2 wasn't touched — same reference.
    expect(controller.getSnapshot().chatMessages[0]).toBe(user2)
  })

  it('handleHistoricalUserMessageDelete returns null for an unknown message id', () => {
    const { controller } = createController('c1', [userMessage('user-1')])
    expect(controller.handleHistoricalUserMessageDelete('missing')).toBeNull()
  })

  it('handleAssistantMessageEditSave replaces the assistant/tool group in place', async () => {
    const user1 = userMessage('user-1')
    const assistant1 = assistantMessage('assistant-1', { content: 'old' })
    const { controller, createOrUpdateConversation } = createController('c1', [
      user1,
      assistant1,
    ])

    const replacement = assistantMessage('assistant-1', { content: 'new' })
    const result = controller.handleAssistantMessageEditSave('assistant-1', [
      replacement,
    ])

    expect(result.changed).toBe(true)
    expect(controller.getSnapshot().chatMessages).toEqual([user1, replacement])
    expect(controller.getSnapshot().chatMessages[0]).toBe(user1)
    expect(createOrUpdateConversation).toHaveBeenCalledTimes(1)
  })

  it('branchFromAssistantGroup slices messages, registers them into AgentService, and persists a new conversation', async () => {
    const user1 = userMessage('user-1')
    const assistant1 = assistantMessage('assistant-1')
    const user2 = userMessage('user-2')
    const assistant2 = assistantMessage('assistant-2')
    const {
      controller,
      agentService,
      createOrUpdateConversationImmediately,
      updateConversationTitle,
    } = createController('c1', [user1, assistant1, user2, assistant2])

    const result = controller.branchFromAssistantGroup(['assistant-1'], {
      nextOverrides: null,
      nextChatMode: 'agent',
      nextPersistedChatMode: 'agent',
      nextYoloEnabled: false,
      conversationAssistantId: 'assistant-1',
      resolvedConversationModelId: 'model-1',
      resolvedReasoningLevel: 'off',
      branchTitle: 'Source (copy)',
    })

    expect(result).not.toBeNull()
    const newConversationId = result!.newConversationId
    expect(newConversationId).not.toBe('c1')

    const snapshot = controller.getSnapshot()
    expect(snapshot.currentConversationId).toBe(newConversationId)
    expect(snapshot.chatMessages).toEqual([user1, assistant1])
    // Retained messages keep their identity across the branch copy.
    expect(snapshot.chatMessages[0]).toBe(user1)
    expect(snapshot.chatMessages[1]).toBe(assistant1)

    // Fix under test: AgentService must have the branched messages registered
    // immediately, not only after the first submit in the new branch.
    expect(agentService.replaceConversationMessages).toHaveBeenCalledWith(
      newConversationId,
      [user1, assistant1],
      [],
      { persistState: true, reason: 'hydrate' },
    )
    expect(agentService.getState(newConversationId).messages).toEqual([
      user1,
      assistant1,
    ])

    await expect(result!.persisted).resolves.toBe(true)
    expect(createOrUpdateConversationImmediately).toHaveBeenCalledTimes(1)
    expect(updateConversationTitle).toHaveBeenCalledWith(
      newConversationId,
      'Source (copy)',
    )
  })

  it('branchFromAssistantGroup returns null when the target ids are not found', () => {
    const { controller } = createController('c1', [userMessage('user-1')])
    const result = controller.branchFromAssistantGroup(['missing'], {
      nextOverrides: null,
      nextChatMode: 'agent',
      nextPersistedChatMode: 'agent',
      nextYoloEnabled: false,
      conversationAssistantId: 'assistant-1',
      resolvedConversationModelId: 'model-1',
      resolvedReasoningLevel: 'off',
      branchTitle: 'Source (copy)',
    })
    expect(result).toBeNull()
  })

  it('keeps unrelated snapshot fields referentially stable across a commit', () => {
    const { controller } = createController('c1', [userMessage('user-1')])
    const before = controller.getSnapshot()

    controller.setPendingCompactionAnchorMessageId('anchor-1')

    const after = controller.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.pendingCompactionAnchorMessageId).toBe('anchor-1')
    // Untouched fields keep their exact prior reference — reference changes
    // iff content changes (see CLAUDE.md "Chat Runtime Invariants").
    expect(after.chatMessages).toBe(before.chatMessages)
    expect(after.messageModelMap).toBe(before.messageModelMap)
    expect(after.messageReasoningMap).toBe(before.messageReasoningMap)
    expect(after.assistantGroupBoundaryMessageIds).toBe(
      before.assistantGroupBoundaryMessageIds,
    )
    expect(after.activeBranchByUserMessageId).toBe(
      before.activeBranchByUserMessageId,
    )
  })

  it('does not notify subscribers when a setter commits the same value', () => {
    const { controller } = createController('c1', [userMessage('user-1')])
    const listener = jest.fn()
    controller.subscribe(listener)

    controller.setChatMessages((prev) => prev)

    expect(listener).not.toHaveBeenCalled()
  })

  it('merges AgentService pushes into its own snapshot once subscribed', () => {
    const { controller, agentService } = createController('c1', [])

    const pushedAssistant = assistantMessage('assistant-1')
    agentService.push('c1', {
      conversationId: 'c1',
      status: 'running',
      messages: [pushedAssistant],
      compaction: [],
      pendingCompactionAnchorMessageId: null,
    })

    expect(controller.getSnapshot().chatMessages).toEqual([pushedAssistant])
  })

  it('re-points its AgentService subscription when the conversation id changes', () => {
    const { controller, agentService } = createController('c1', [])

    controller.setCurrentConversationId('c2')
    agentService.push('c2', {
      conversationId: 'c2',
      status: 'idle',
      messages: [userMessage('user-only-in-c2')],
      compaction: [],
      pendingCompactionAnchorMessageId: null,
    })

    expect(controller.getSnapshot().chatMessages).toEqual([
      userMessage('user-only-in-c2'),
    ])

    // A push to the old conversation id must no longer reach this controller.
    agentService.push('c1', {
      conversationId: 'c1',
      status: 'running',
      messages: [assistantMessage('should-not-apply')],
      compaction: [],
      pendingCompactionAnchorMessageId: null,
    })
    expect(controller.getSnapshot().chatMessages).toEqual([
      userMessage('user-only-in-c2'),
    ])
  })

  it('resumeAgentSubscription re-establishes the subscription after dispose (StrictMode replay)', () => {
    const { controller, agentService } = createController('c1', [])

    // StrictMode dev double-mount: effect cleanup disposes, then the replayed
    // setup resumes. Pushes during the gap are dropped; pushes after resume
    // must merge again.
    controller.dispose()
    agentService.push('c1', {
      conversationId: 'c1',
      status: 'running',
      messages: [assistantMessage('dropped-while-disposed')],
      compaction: [],
      pendingCompactionAnchorMessageId: null,
    })
    expect(controller.getSnapshot().chatMessages).toEqual([])

    controller.resumeAgentSubscription()
    // resume syncs the current AgentService state immediately…
    expect(controller.getSnapshot().chatMessages).toEqual([
      assistantMessage('dropped-while-disposed'),
    ])
    // …and future pushes flow again. A second resume while subscribed is a no-op.
    controller.resumeAgentSubscription()
    agentService.push('c1', {
      conversationId: 'c1',
      status: 'running',
      messages: [assistantMessage('after-resume')],
      compaction: [],
      pendingCompactionAnchorMessageId: null,
    })
    expect(controller.getSnapshot().chatMessages).toEqual([
      assistantMessage('after-resume'),
    ])
  })
})
