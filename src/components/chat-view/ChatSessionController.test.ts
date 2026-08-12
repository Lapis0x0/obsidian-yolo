import type {
  AgentConversationRunSummary,
  AgentConversationState,
  AgentService,
} from '../../core/agent/service'
import type {
  CliConversationController,
  CliRuntimeScope,
} from '../../core/cli-runtime'
import { SETTINGS_SCHEMA_VERSION } from '../../settings/schema/migrations'
import { parseYoloSettings } from '../../settings/schema/settings'
import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatUserMessage,
} from '../../types/chat'

import type {
  ChatSessionCliContext,
  ChatSessionControllerDeps,
} from './ChatSessionController'
import { ChatSessionController } from './ChatSessionController'
import type { CliChatOperationCoordinator } from './cliChatIntegration'
import { ConversationPreferencesController } from './ConversationPreferencesController'

const idleRunSummary: Pick<
  AgentConversationRunSummary,
  'isActive' | 'isQueueable' | 'isWaitingApproval' | 'isWaitingUserInput'
> = {
  isActive: false,
  isQueueable: false,
  isWaitingApproval: false,
  isWaitingUserInput: false,
}

/** Minimal `ChatSessionCliContext` stub — enough to exercise `submit`/
 * `abortRun`'s CLI branch orchestration (begin/finish submission, error
 * translation) without pulling in the real CLI turn machinery, which
 * `cliChatIntegration.test.ts` already covers directly. */
function createCliContext(overrides: Partial<ChatSessionCliContext> = {}): {
  cliContext: ChatSessionCliContext
  coordinator: {
    beginSubmission: jest.Mock
    finishSubmission: jest.Mock
    cancelCurrentOperation: jest.Mock
    getSnapshot: jest.Mock
  }
} {
  const coordinator = {
    beginSubmission: jest.fn(() => ({
      token: 1,
      signal: new AbortController().signal,
    })),
    markSending: jest.fn(() => true),
    markPresented: jest.fn(() => true),
    markAccepted: jest.fn(() => true),
    finishSubmission: jest.fn(),
    cancelCurrentOperation: jest.fn(async () => undefined),
    getSnapshot: jest.fn(() => ({ acceptedDraft: null })),
  }
  const controller = {
    getSnapshot: () => ({ runState: 'idle', isCompacting: false }),
  } as unknown as CliConversationController
  const cliContext: ChatSessionCliContext = {
    runtimeId: 'claude-code',
    controller,
    coordinator: coordinator as unknown as CliChatOperationCoordinator,
    scope: {} as CliRuntimeScope,
    settings: parseYoloSettings({ version: SETTINGS_SCHEMA_VERSION }),
    chatMode: 'agent',
    yoloEnabled: false,
    cliConversationId: null,
    getDraftRevision: () => 0,
    buildEnvironmentContext: jest.fn(async () => []),
    createOrTouchCliConversation: jest.fn(async () => undefined),
    generateConversationTitle: jest.fn(async () => null),
    syncCliConversationTitle: jest.fn(),
    setCliConversationId: jest.fn(),
    consumeAcceptedCliDraft: jest.fn(),
    isMounted: () => true,
    ...overrides,
  }
  return { cliContext, coordinator }
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

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

  const enqueueUserMessage = jest.fn(
    (_conversationId: string, _message: ChatUserMessage) =>
      'idle' as 'enqueued' | 'blocked_awaiting_approval' | 'idle',
  )

  return {
    getState,
    replaceConversationMessages,
    subscribe,
    enqueueUserMessage,
    push,
  } as unknown as Pick<
    AgentService,
    | 'subscribe'
    | 'getState'
    | 'replaceConversationMessages'
    | 'enqueueUserMessage'
  > & {
    replaceConversationMessages: jest.Mock
    subscribe: jest.Mock
    enqueueUserMessage: jest.Mock
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
  const updateConversationTitle = jest.fn(async () => undefined)
  const compileUserMessagePrompt = jest.fn(async () => ({
    promptContent: null,
  }))
  const getRequestContextBuilder = jest.fn(() => ({ compileUserMessagePrompt }))
  const runConversation = jest.fn()
  const abortConversationRun = jest.fn()
  const compactConversation = jest.fn(
    async (
      _messages: ChatMessage[],
    ): Promise<{
      anchorMessageId: string
      summary: string
      compactedAt: number
    } | null> => null,
  )
  const generateConversationTitle = jest.fn(async () => null)
  const forceScrollToBottom = jest.fn()
  const setQueryProgress = jest.fn()
  const runtimeNavigationGenerationRef = { current: 0 }
  const getCliSubmitContext = jest.fn((): ChatSessionCliContext | null => null)
  const deps: ChatSessionControllerDeps = {
    getAgentService: () => agentService,
    createOrUpdateConversation,
    createOrUpdateConversationImmediately,
    updateConversationTitle,
    chatModeForSave: (mode) => mode,
    getRequestContextBuilder,
    runConversation,
    abortConversationRun,
    compactConversation,
    generateConversationTitle,
    forceScrollToBottom,
    setQueryProgress,
    runtimeNavigationGenerationRef,
    getCliSubmitContext,
  }
  return {
    deps,
    createOrUpdateConversation,
    createOrUpdateConversationImmediately,
    updateConversationTitle,
    compileUserMessagePrompt,
    runConversation,
    abortConversationRun,
    compactConversation,
    generateConversationTitle,
    forceScrollToBottom,
    setQueryProgress,
    getCliSubmitContext,
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

  it('keeps the conversation and persists an empty list when the last message is removed', async () => {
    const user1 = userMessage('user-1')
    const { controller, createOrUpdateConversation, agentService } =
      createController('c1', [user1])

    const result = controller.removeHistoricalUserMessage('user-1')

    expect(result.outcome.kind).toBe('persisted')
    await expect(result.outcome.ok).resolves.toBe(true)
    expect(controller.getSnapshot().chatMessages).toEqual([])
    // Emptying is a message-level edit, not a conversation deletion: the id
    // stays alive (an AgentService `dropConversation` would tombstone it and
    // silently drop every later run) and the empty list is written back.
    expect(agentService.replaceConversationMessages).toHaveBeenCalledWith(
      'c1',
      [],
      [],
    )
    expect(createOrUpdateConversation).toHaveBeenCalledTimes(1)
    expect(createOrUpdateConversation.mock.calls[0].slice(0, 2)).toEqual([
      'c1',
      [],
    ])
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

describe('ChatSessionController — C2 submit/abortRun/compactContext/retry', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('submit (yolo runtime)', () => {
    it('blocks when the run is waiting for user input', () => {
      const { controller } = createController('c1', [])
      const result = controller.submit({
        runtimeId: 'yolo',
        message: userMessage('draft-1'),
        assistantTimeContextEnabled: false,
        currentConversationRunSummary: {
          ...idleRunSummary,
          isWaitingUserInput: true,
        },
      })
      expect(result).toEqual({ kind: 'blocked_waiting_user_input' })
    })

    it('blocks when the run is waiting for tool approval', () => {
      const { controller } = createController('c1', [])
      const result = controller.submit({
        runtimeId: 'yolo',
        message: userMessage('draft-1'),
        assistantTimeContextEnabled: false,
        currentConversationRunSummary: {
          ...idleRunSummary,
          isWaitingApproval: true,
        },
      })
      expect(result).toEqual({ kind: 'blocked_waiting_approval' })
    })

    it('enqueues into AgentService while queueable, without touching chatMessages', () => {
      const { controller, agentService } = createController('c1', [])
      agentService.enqueueUserMessage.mockReturnValueOnce('enqueued')
      const result = controller.submit({
        runtimeId: 'yolo',
        message: userMessage('draft-1'),
        assistantTimeContextEnabled: false,
        currentConversationRunSummary: { ...idleRunSummary, isQueueable: true },
      })
      expect(result.kind).toBe('enqueued')
      expect(agentService.enqueueUserMessage).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ id: 'draft-1' }),
      )
      expect(controller.getSnapshot().chatMessages).toEqual([])
      expect(controller.getSnapshot().messageReasoningMap.get('draft-1')).toBe(
        'off',
      )
    })

    it('reports blocked_enqueue_awaiting_approval when the queue rejects', () => {
      const { controller, agentService } = createController('c1', [])
      agentService.enqueueUserMessage.mockReturnValueOnce(
        'blocked_awaiting_approval',
      )
      const result = controller.submit({
        runtimeId: 'yolo',
        message: userMessage('draft-1'),
        assistantTimeContextEnabled: false,
        currentConversationRunSummary: { ...idleRunSummary, isQueueable: true },
      })
      expect(result).toEqual({ kind: 'blocked_enqueue_awaiting_approval' })
    })

    it('blocks when a foreground tool call is active', () => {
      const { controller } = createController('c1', [])
      const result = controller.submit({
        runtimeId: 'yolo',
        message: userMessage('draft-1'),
        assistantTimeContextEnabled: false,
        currentConversationRunSummary: { ...idleRunSummary, isActive: true },
      })
      expect(result).toEqual({ kind: 'blocked_active_tool' })
    })

    it('falls through to a normal submit when the queue is idle', async () => {
      const { controller, agentService, runConversation } = createController(
        'c1',
        [],
      )
      agentService.enqueueUserMessage.mockReturnValueOnce('idle')
      const result = controller.submit({
        runtimeId: 'yolo',
        message: userMessage('draft-1'),
        assistantTimeContextEnabled: false,
        currentConversationRunSummary: { ...idleRunSummary, isQueueable: true },
      })
      expect(result.kind).toBe('submitted')
      await flushMicrotasks()
      expect(runConversation).toHaveBeenCalled()
      expect(controller.getSnapshot().chatMessages.map((m) => m.id)).toEqual([
        'draft-1',
      ])
    })

    it('registers the message into AgentService and triggers the injected run on a plain idle submit', async () => {
      const {
        controller,
        agentService,
        runConversation,
        createOrUpdateConversation,
        generateConversationTitle,
      } = createController('c1', [])

      const result = controller.submit({
        runtimeId: 'yolo',
        message: userMessage('draft-1'),
        assistantTimeContextEnabled: true,
        currentConversationRunSummary: idleRunSummary,
      })
      expect(result.kind).toBe('submitted')
      await flushMicrotasks()

      expect(controller.getSnapshot().chatMessages.map((m) => m.id)).toEqual([
        'draft-1',
      ])
      expect(controller.getSnapshot().messageModelMap.get('draft-1')).toBe(
        'model-1',
      )
      expect(controller.getSnapshot().messageReasoningMap.get('draft-1')).toBe(
        'off',
      )
      // Submitted through the yolo main line — registered into AgentService…
      expect(agentService.replaceConversationMessages).toHaveBeenCalledWith(
        'c1',
        expect.arrayContaining([expect.objectContaining({ id: 'draft-1' })]),
        [],
      )
      // …and the injected run trigger fires with the same conversation.
      expect(runConversation).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1' }),
      )
      expect(createOrUpdateConversation).toHaveBeenCalled()
      expect(generateConversationTitle).toHaveBeenCalled()
      // `assistantTimeContextEnabled: true` stamps the new-turn message.
      expect(controller.getSnapshot().chatMessages[0]).toMatchObject({
        timeContext: expect.anything(),
      })
    })
  })

  describe('submit (CLI runtime)', () => {
    it('reports cli_unavailable when no CLI context is ready', () => {
      const { controller } = createController('c1', [])
      const result = controller.submit({
        runtimeId: 'claude-code',
        message: userMessage('draft-1'),
        assistantTimeContextEnabled: false,
        currentConversationRunSummary: idleRunSummary,
      })
      expect(result).toEqual({ kind: 'cli_unavailable' })
    })

    it('reports cli_busy when the CLI conversation is already running', () => {
      const { controller, getCliSubmitContext } = createController('c1', [])
      const { cliContext } = createCliContext({
        controller: {
          getSnapshot: () => ({ runState: 'running', isCompacting: false }),
        } as unknown as CliConversationController,
      })
      getCliSubmitContext.mockReturnValue(cliContext)
      const result = controller.submit({
        runtimeId: 'claude-code',
        message: userMessage('draft-1'),
        assistantTimeContextEnabled: false,
        currentConversationRunSummary: idleRunSummary,
      })
      expect(result).toEqual({ kind: 'cli_busy' })
    })

    it('resolves settled with a typed error outcome and always finishes the submission', async () => {
      const { controller, getCliSubmitContext } = createController('c1', [])
      const { cliContext, coordinator } = createCliContext({
        buildEnvironmentContext: jest.fn(async () => {
          throw new Error('environment build failed')
        }),
      })
      getCliSubmitContext.mockReturnValue(cliContext)

      const result = controller.submit({
        runtimeId: 'claude-code',
        message: userMessage('draft-1'),
        assistantTimeContextEnabled: false,
        currentConversationRunSummary: idleRunSummary,
      })
      expect(result.kind).toBe('cli_submitted')
      if (result.kind !== 'cli_submitted') throw new Error('unreachable')
      await expect(result.settled).resolves.toEqual({
        kind: 'error',
        message: 'environment build failed',
      })
      expect(coordinator.finishSubmission).toHaveBeenCalledWith(1)
    })
  })

  describe('abortRun', () => {
    it('aborts the yolo run through the injected dep', () => {
      const { controller, abortConversationRun } = createController('c1', [])
      const result = controller.abortRun({ runtimeId: 'yolo' })
      expect(result).toEqual({ kind: 'yolo_aborted' })
      expect(abortConversationRun).toHaveBeenCalledWith('c1')
    })

    it('reports cli_unavailable with no ready CLI context', () => {
      const { controller } = createController('c1', [])
      const result = controller.abortRun({ runtimeId: 'claude-code' })
      expect(result).toEqual({ kind: 'cli_unavailable' })
    })

    it('cancels the CLI operation and resolves ok on success', async () => {
      const { controller, getCliSubmitContext } = createController('c1', [])
      const { cliContext, coordinator } = createCliContext()
      getCliSubmitContext.mockReturnValue(cliContext)

      const result = controller.abortRun({ runtimeId: 'claude-code' })
      expect(result.kind).toBe('cli_cancelling')
      if (result.kind !== 'cli_cancelling') throw new Error('unreachable')
      await expect(result.settled).resolves.toEqual({ ok: true })
      expect(coordinator.cancelCurrentOperation).toHaveBeenCalledWith(
        cliContext.controller,
      )
    })

    it('surfaces a typed error when the CLI cancel rejects', async () => {
      const { controller, getCliSubmitContext } = createController('c1', [])
      const { cliContext, coordinator } = createCliContext()
      coordinator.cancelCurrentOperation.mockRejectedValueOnce(
        new Error('cancel failed'),
      )
      getCliSubmitContext.mockReturnValue(cliContext)

      const result = controller.abortRun({ runtimeId: 'claude-code' })
      expect(result.kind).toBe('cli_cancelling')
      if (result.kind !== 'cli_cancelling') throw new Error('unreachable')
      await expect(result.settled).resolves.toEqual({
        ok: false,
        message: 'cancel failed',
      })
    })
  })

  describe('compactContext', () => {
    it('blocks when waiting for tool approval', async () => {
      const { controller } = createController('c1', [userMessage('u1')])
      const result = await controller.compactContext({
        currentConversationRunSummary: {
          isActive: false,
          isWaitingApproval: true,
        },
      })
      expect(result).toEqual({ kind: 'blocked_waiting_approval' })
    })

    it('blocks while a run is active', async () => {
      const { controller } = createController('c1', [userMessage('u1')])
      const result = await controller.compactContext({
        currentConversationRunSummary: {
          isActive: true,
          isWaitingApproval: false,
        },
      })
      expect(result).toEqual({ kind: 'blocked_active' })
    })

    it('reports empty when there is nothing to compact', async () => {
      const { controller } = createController('c1', [])
      const result = await controller.compactContext({
        currentConversationRunSummary: {
          isActive: false,
          isWaitingApproval: false,
        },
      })
      expect(result).toEqual({ kind: 'empty' })
    })

    it('compacts, persists immediately, and folds the entry back through the AgentService subscription', async () => {
      const {
        controller,
        agentService,
        compactConversation,
        createOrUpdateConversationImmediately,
      } = createController('c1', [userMessage('u1')])
      compactConversation.mockResolvedValueOnce({
        anchorMessageId: 'u1',
        summary: 'summary text',
        compactedAt: Date.now(),
      })

      const result = await controller.compactContext({
        currentConversationRunSummary: {
          isActive: false,
          isWaitingApproval: false,
        },
      })

      expect(result).toEqual({ kind: 'compacted' })
      expect(agentService.replaceConversationMessages).toHaveBeenCalledWith(
        'c1',
        [userMessage('u1')],
        [expect.objectContaining({ anchorMessageId: 'u1' })],
      )
      // The controller never calls `setCompactionState` itself — this proves
      // the implicit-dependency note in `compactContext`'s doc comment: the
      // entry above reached this snapshot only via the controller's own
      // AgentService subscription re-merging.
      expect(controller.getSnapshot().compactionState).toEqual([
        expect.objectContaining({ anchorMessageId: 'u1' }),
      ])
      expect(createOrUpdateConversationImmediately).toHaveBeenCalled()
      expect(
        controller.getSnapshot().pendingCompactionAnchorMessageId,
      ).toBeNull()
    })

    it('reports failed and clears the pending anchor when compaction throws', async () => {
      const { controller, compactConversation } = createController('c1', [
        userMessage('u1'),
      ])
      compactConversation.mockRejectedValueOnce(new Error('boom'))

      const result = await controller.compactContext({
        currentConversationRunSummary: {
          isActive: false,
          isWaitingApproval: false,
        },
      })

      expect(result.kind).toBe('failed')
      expect(
        controller.getSnapshot().pendingCompactionAnchorMessageId,
      ).toBeNull()
    })
  })

  describe('retryAssistantMessageGroup', () => {
    it('reports failed when no matching group is found', () => {
      const { controller } = createController('c1', [userMessage('u1')])
      const result = controller.retryAssistantMessageGroup(['missing'])
      expect(result).toEqual({ kind: 'failed' })
    })

    it('drops the retried group, resubmits, and registers the trimmed history into AgentService', async () => {
      const user1 = userMessage('user-1')
      const assistant1 = assistantMessage('assistant-1')
      const { controller, agentService, runConversation } = createController(
        'c1',
        [user1, assistant1],
      )

      const result = controller.retryAssistantMessageGroup(['assistant-1'])
      expect(result).toEqual({ kind: 'submitted' })
      await flushMicrotasks()

      expect(controller.getSnapshot().chatMessages).toEqual([user1])
      expect(agentService.replaceConversationMessages).toHaveBeenCalledWith(
        'c1',
        [user1],
        [],
      )
      expect(runConversation).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1' }),
      )
    })
  })

  describe('continueAssistantError', () => {
    it('reports failed when no matching continuation payload is found', () => {
      const { controller } = createController('c1', [userMessage('u1')])
      const result = controller.continueAssistantError('missing')
      expect(result).toEqual({ kind: 'failed' })
    })

    it('starts a continuation, guards against re-entrant calls, and resets after the run settles', () => {
      const user1 = userMessage('user-1')
      const erroredAssistant = assistantMessage('assistant-1', {
        content: 'partial answer',
        metadata: {
          generationState: 'error',
          model: { id: 'model-1', model: 'model-1', providerId: 'provider-1' },
        },
      })
      const { controller, runConversation, forceScrollToBottom } =
        createController('c1', [user1, erroredAssistant])

      const started = controller.continueAssistantError('assistant-1')
      expect(started).toEqual({ kind: 'started' })
      expect(forceScrollToBottom).toHaveBeenCalled()
      expect(runConversation).toHaveBeenCalledTimes(1)
      const [params, options] = runConversation.mock.calls[0]
      expect(params).toMatchObject({
        conversationId: 'c1',
        assistantContinuation: expect.objectContaining({
          assistantMessageId: 'assistant-1',
          sourceUserMessageId: 'user-1',
          modelId: 'model-1',
        }),
      })

      // A re-entrant call while the continuation is still in flight is guarded
      // (mirrors the pre-C2 `assistantContinuationPendingRef`).
      const pending = controller.continueAssistantError('assistant-1')
      expect(pending).toEqual({ kind: 'pending' })
      expect(runConversation).toHaveBeenCalledTimes(1)

      // Once the injected run settles, the guard resets.
      ;(options as { onSettled?: () => void } | undefined)?.onSettled?.()
      const startedAgain = controller.continueAssistantError('assistant-1')
      expect(startedAgain).toEqual({ kind: 'started' })
      expect(runConversation).toHaveBeenCalledTimes(2)
    })
  })

  describe('continueResponse', () => {
    it('re-runs the conversation with the resolved reasoning level and last message model ids', () => {
      const user1 = userMessage('user-1', { selectedModelIds: ['model-a'] })
      const { controller, runConversation } = createController('c1', [user1])

      controller.continueResponse()

      expect(runConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'c1',
          chatMessages: [user1],
          modelIds: ['model-a'],
        }),
      )
    })
  })

  describe('recoverAnswerUserQuestion', () => {
    it('replaces the working copy, registers + persists it, and triggers a fresh run', async () => {
      const user1 = userMessage('user-1')
      const resolvedMessages: ChatMessage[] = [
        user1,
        assistantMessage('assistant-2'),
      ]
      const {
        controller,
        agentService,
        runConversation,
        createOrUpdateConversationImmediately,
      } = createController('c1', [user1])

      controller.recoverAnswerUserQuestion(resolvedMessages)

      expect(controller.getSnapshot().chatMessages).toEqual(resolvedMessages)
      expect(agentService.replaceConversationMessages).toHaveBeenCalledWith(
        'c1',
        resolvedMessages,
        [],
        { persistState: true },
      )
      await flushMicrotasks()
      expect(createOrUpdateConversationImmediately).toHaveBeenCalled()
      expect(runConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'c1',
          chatMessages: resolvedMessages,
        }),
      )
    })
  })

  describe('conversation switch during awaited work', () => {
    it('submit finishes against the originating conversation after a mid-compile switch', async () => {
      const draft = userMessage('draft-1')
      const {
        controller,
        agentService,
        compileUserMessagePrompt,
        createOrUpdateConversation,
        generateConversationTitle,
        runConversation,
      } = createController('c1', [])

      let resolveCompile!: (value: { promptContent: null }) => void
      compileUserMessagePrompt.mockImplementationOnce(
        () =>
          new Promise<{ promptContent: null }>((resolve) => {
            resolveCompile = resolve
          }),
      )

      const result = controller.submit({
        runtimeId: 'yolo',
        message: draft,
        assistantTimeContextEnabled: false,
        currentConversationRunSummary: idleRunSummary,
      })
      expect(result.kind).toBe('submitted')

      // The user loads another conversation while the prompt is compiling.
      controller.setCurrentConversationId('c2')
      const c2Messages = [userMessage('c2-user')]
      controller.setChatMessages(c2Messages)

      resolveCompile({ promptContent: null })
      await flushMicrotasks()

      // Persistence, registration, title generation, and the run all target
      // the conversation the submission started in…
      expect(agentService.replaceConversationMessages).toHaveBeenCalledWith(
        'c1',
        expect.anything(),
        expect.anything(),
      )
      expect((createOrUpdateConversation.mock.calls[0] as unknown[])[0]).toBe(
        'c1',
      )
      expect(generateConversationTitle).toHaveBeenCalledWith(
        'c1',
        expect.anything(),
      )
      expect(runConversation).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1' }),
      )
      // …while the now-displayed conversation's working copy is left alone.
      expect(controller.getSnapshot().currentConversationId).toBe('c2')
      expect(controller.getSnapshot().chatMessages).toBe(c2Messages)
    })

    it('compactContext persists to the originating conversation after a mid-compaction switch', async () => {
      const user1 = userMessage('user-1')
      const {
        controller,
        agentService,
        compactConversation,
        createOrUpdateConversationImmediately,
      } = createController('c1', [user1])

      let resolveCompaction!: (
        value: {
          anchorMessageId: string
          summary: string
          compactedAt: number
        } | null,
      ) => void
      compactConversation.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCompaction = resolve
          }),
      )

      const pending = controller.compactContext({
        currentConversationRunSummary: idleRunSummary,
      })
      expect(controller.getSnapshot().pendingCompactionAnchorMessageId).toBe(
        'user-1',
      )

      // Switch away mid-compaction; the new conversation even starts its own
      // pending anchor, which the finishing compaction must not clobber.
      controller.setCurrentConversationId('c2')
      controller.setChatMessages([userMessage('c2-user')])
      controller.setPendingCompactionAnchorMessageId('c2-anchor')

      resolveCompaction({
        anchorMessageId: 'user-1',
        summary: 'summary',
        compactedAt: 1,
      })
      await expect(pending).resolves.toEqual({ kind: 'compacted' })

      expect(agentService.replaceConversationMessages).toHaveBeenCalledWith(
        'c1',
        [user1],
        [expect.objectContaining({ anchorMessageId: 'user-1' })],
      )
      expect(
        (createOrUpdateConversationImmediately.mock.calls[0] as unknown[])[0],
      ).toBe('c1')
      expect(controller.getSnapshot().pendingCompactionAnchorMessageId).toBe(
        'c2-anchor',
      )
    })
  })
})
