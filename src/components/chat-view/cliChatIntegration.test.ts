import type { SerializedEditorState } from 'lexical'

import type {
  CliConversationController,
  CliConversationSnapshot,
  CliRuntimeScope,
  CliSessionDiscoveryResult,
  CliSessionHydration,
  CliSessionRef,
} from '../../core/cli-runtime'
import { SETTINGS_SCHEMA_VERSION } from '../../settings/schema/migrations'
import type { YoloSettings } from '../../settings/schema/setting.types'
import { parseYoloSettings } from '../../settings/schema/settings'
import type { ChatUserMessage } from '../../types/chat'

import {
  CliChatOperationCoordinator,
  beginChatRuntimeNavigation,
  invalidateChatRuntimeNavigation,
  openCliSession,
  openCliSessionForNavigation,
  prepareCliConversation,
  removeCliOverlayAfterConfirmation,
  resolveActiveAssistantId,
  resolveActiveCliConversationSnapshot,
  resolveChatRuntimeId,
  shouldClearAcceptedCliDraft,
  shouldHydrateSeededCliSession,
  shouldLoadYoloHistoryItem,
  submitCliComposerTurn,
} from './cliChatIntegration'

const editorState = (text: string): SerializedEditorState =>
  ({
    root: {
      children: [
        {
          children: [{ type: 'text', text, version: 1 }],
          type: 'paragraph',
          version: 1,
        },
      ],
      type: 'root',
      version: 1,
    },
  }) as unknown as SerializedEditorState

const userMessage = (): ChatUserMessage => ({
  role: 'user',
  id: 'draft-1',
  content: editorState('Run the focused task'),
  promptContent: null,
  mentionables: [
    {
      type: 'file',
      file: { path: 'spec.md' },
    } as ChatUserMessage['mentionables'][number],
  ],
  selectedSkills: [
    { name: 'review', description: 'Review changes', path: 'review' },
  ],
})

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('Condition did not become true')
}

const cliSnapshot = (
  overrides: Partial<CliConversationSnapshot> = {},
): CliConversationSnapshot => ({
  surfaceId: 'cli:codex:test-surface',
  runtimeId: 'codex',
  messages: [],
  sessionRef: null,
  runState: 'idle',
  error: null,
  ...overrides,
})

describe('CLI chat integration', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('tracks UI presentation separately from native turn acceptance', () => {
    const coordinator = new CliChatOperationCoordinator()
    const operation = coordinator.beginSubmission(11)!
    const message = userMessage()

    expect(coordinator.markPresented(operation.token, message)).toBe(true)
    expect(coordinator.getSnapshot()).toMatchObject({
      submissionPhase: 'preparing',
      presentedDraft: {
        draftRevision: 11,
        userMessage: { id: message.id },
      },
      acceptedDraft: null,
    })

    coordinator.acknowledgePresentedDraft(operation.token)
    expect(coordinator.getSnapshot().presentedDraft).toBeNull()
    coordinator.finishSubmission(operation.token)
  })

  it('prepares a fresh runtime with its remembered model and effort', async () => {
    const ensureReady = jest.fn(async () => undefined)
    const controller = {
      stageTurn: jest.fn((message: ChatUserMessage) => ({
        surfaceId: 'cli:codex:test',
        conversationEpoch: 0,
        userMessageId: message.id,
      })),
      rejectStagedTurn: jest.fn(),
      ensureReady,
      getSnapshot: () => cliSnapshot(),
    } as unknown as CliConversationController
    const scope = {
      getModelCatalogSnapshot: () =>
        new Map([
          [
            'codex',
            [
              {
                id: 'gpt-5.6-luna',
                label: 'Luna',
                reasoningEfforts: [{ id: 'medium' }],
              },
            ],
          ],
        ]),
      sessionService: {},
    } as unknown as CliRuntimeScope
    const settings = parseYoloSettings({
      version: SETTINGS_SCHEMA_VERSION,
      chatOptions: {
        includeCurrentFileContent: true,
        cliModelIdByRuntime: { codex: 'gpt-5.6-luna' },
        cliReasoningEffortByModel: {
          'codex:gpt-5.6-luna': 'medium',
        },
      },
    })
    const assistant = {
      assistantId: 'assistant-1',
      systemPrompt: 'Be precise.',
      enabledSkillNames: [],
    }

    await prepareCliConversation({
      controller,
      scope,
      runtimeId: 'codex',
      assistant,
      settings,
    })

    expect(ensureReady).toHaveBeenCalledWith(assistant, {
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
    })
  })

  it('falls back to YOLO without a desktop scope and resolves runtime-owned assistants', () => {
    expect(
      resolveChatRuntimeId({
        requestedRuntimeId: 'codex',
        hasCliRuntimeScope: true,
        cliRuntimeAvailable: true,
      }),
    ).toBe('codex')
    expect(
      resolveChatRuntimeId({
        requestedRuntimeId: 'claude-code',
        hasCliRuntimeScope: false,
        cliRuntimeAvailable: true,
      }),
    ).toBe('yolo')
    expect(
      resolveChatRuntimeId({
        requestedRuntimeId: 'codex',
        hasCliRuntimeScope: true,
        cliRuntimeAvailable: false,
      }),
    ).toBe('yolo')
    expect(
      resolveChatRuntimeId({
        requestedRuntimeId: undefined,
        hasCliRuntimeScope: true,
        cliRuntimeAvailable: true,
      }),
    ).toBe('yolo')

    const cliSnapshot = {
      surfaceId: 'codex:snapshot-session',
      runtimeId: 'codex' as const,
      messages: [],
      sessionRef: {
        runtimeId: 'codex' as const,
        nativeSessionId: 'snapshot-session',
      },
      runState: 'idle' as const,
      error: null,
    }
    expect(resolveActiveCliConversationSnapshot('codex', cliSnapshot)).toBe(
      cliSnapshot,
    )
    expect(
      resolveActiveCliConversationSnapshot('claude-code', cliSnapshot),
    ).toBeNull()
    expect(resolveActiveCliConversationSnapshot('yolo', cliSnapshot)).toBeNull()

    expect(
      resolveActiveAssistantId({
        activeRuntimeId: 'yolo',
        conversationAssistantId: 'assistant-yolo',
        cliAssistantId: 'assistant-cli',
      }),
    ).toBe('assistant-yolo')
    expect(
      resolveActiveAssistantId({
        activeRuntimeId: 'codex',
        conversationAssistantId: 'assistant-yolo',
        cliAssistantId: 'assistant-cli',
      }),
    ).toBe('assistant-cli')
  })

  it('encodes and submits the CLI draft through its assistant binding', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 6, 30, 14, 53))
    const ref: CliSessionRef = {
      runtimeId: 'codex',
      nativeSessionId: 'native-1',
    }
    const ensureReady = jest.fn(async () => undefined)
    const sendTurn = jest.fn(async () => undefined)
    const recordOpenedSession = jest.fn(async () => undefined)
    const controller = {
      stageTurn: jest.fn((message: ChatUserMessage) => ({
        surfaceId: 'cli:codex:test',
        conversationEpoch: 0,
        userMessageId: message.id,
      })),
      rejectStagedTurn: jest.fn(),
      ensureReady,
      sendTurn,
      getSnapshot: () => ({
        runtimeId: 'codex' as const,
        messages: [],
        sessionRef: ref,
        runState: 'running' as const,
        error: null,
      }),
    } as unknown as CliConversationController
    const scope = {
      sessionService: {
        recordUserDisplay: jest.fn(async () => undefined),
        recordOpenedSession,
      },
    } as unknown as CliRuntimeScope
    const encodeTurnContent = jest.fn(() => 'encoded CLI content')
    const resolveAssistantBinding = jest.fn(async () => ({
      assistantId: 'assistant-1',
      systemPrompt: 'Be precise.',
      enabledSkillNames: ['review'],
    }))

    await submitCliComposerTurn({
      app: {} as never,
      settings: { assistants: [] } as unknown as YoloSettings,
      scope,
      controller,
      runtimeId: 'codex',
      assistantId: 'assistant-1',
      userMessage: userMessage(),
      timeContextEnabled: true,
      resolveAssistantBinding,
      encodeTurnContent,
    })

    expect(encodeTurnContent).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: 'codex',
        text: 'Run the focused task',
        mentionables: expect.any(Array),
        selectedSkills: expect.any(Array),
        timeContext: '2026-07-30 14:53 (Thursday)',
      }),
    )
    expect(ensureReady).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: 'assistant-1' }),
      {},
    )
    expect(sendTurn).toHaveBeenCalledWith({
      userMessage: expect.objectContaining({
        id: 'draft-1',
        promptContent: null,
      }),
      content: 'encoded CLI content',
      selectedSkillNames: ['review'],
    })
    expect(recordOpenedSession).toHaveBeenCalledWith(
      { ref, messages: [] },
      { assistantId: 'assistant-1' },
    )
    expect(ensureReady.mock.invocationCallOrder[0]).toBeLessThan(
      sendTurn.mock.invocationCallOrder[0] ?? 0,
    )
    expect(sendTurn.mock.invocationCallOrder[0]).toBeLessThan(
      recordOpenedSession.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it('reports an overlay write failure after the native turn was accepted', async () => {
    const overlayError = new Error('index unavailable')
    const ref: CliSessionRef = {
      runtimeId: 'codex',
      nativeSessionId: 'native-accepted',
    }
    const controller = {
      stageTurn: jest.fn((message: ChatUserMessage) => ({
        surfaceId: 'cli:codex:test',
        conversationEpoch: 0,
        userMessageId: message.id,
      })),
      rejectStagedTurn: jest.fn(),
      ensureReady: jest.fn(async () => undefined),
      sendTurn: jest.fn(async () => undefined),
      getSnapshot: () => ({
        runtimeId: 'codex' as const,
        messages: [],
        sessionRef: ref,
        runState: 'running' as const,
        error: null,
      }),
    } as unknown as CliConversationController
    const scope = {
      sessionService: {
        recordUserDisplay: jest.fn(async () => undefined),
        recordOpenedSession: jest.fn(async () => {
          throw overlayError
        }),
      },
    } as unknown as CliRuntimeScope

    await expect(
      submitCliComposerTurn({
        app: {} as never,
        settings: { assistants: [] } as unknown as YoloSettings,
        scope,
        controller,
        runtimeId: 'codex',
        assistantId: 'assistant-1',
        userMessage: userMessage(),
        timeContextEnabled: false,
        resolveAssistantBinding: async () => ({
          assistantId: 'assistant-1',
          systemPrompt: '',
          enabledSkillNames: [],
        }),
        encodeTurnContent: () => 'accepted',
      }),
    ).resolves.toEqual({
      userMessage: userMessage(),
      overlayError,
    })
  })

  it('aborts an unmounted preparation before it can reach sendTurn', async () => {
    let resolveBinding!: (value: {
      assistantId: string
      systemPrompt: string
      enabledSkillNames: string[]
    }) => void
    const binding = new Promise<{
      assistantId: string
      systemPrompt: string
      enabledSkillNames: string[]
    }>((resolve) => {
      resolveBinding = resolve
    })
    const ensureReady = jest.fn(async () => undefined)
    const sendTurn = jest.fn(async () => undefined)
    const controller = {
      stageTurn: jest.fn((message: ChatUserMessage) => ({
        surfaceId: 'cli:codex:test',
        conversationEpoch: 0,
        userMessageId: message.id,
      })),
      rejectStagedTurn: jest.fn(),
      ensureReady,
      sendTurn,
    } as unknown as CliConversationController

    const coordinator = new CliChatOperationCoordinator()
    const operation = coordinator.beginSubmission(3)
    expect(operation).not.toBeNull()

    const submission = submitCliComposerTurn({
      app: {} as never,
      settings: { assistants: [] } as unknown as YoloSettings,
      scope: {} as CliRuntimeScope,
      controller,
      runtimeId: 'codex',
      assistantId: 'assistant-1',
      userMessage: userMessage(),
      timeContextEnabled: false,
      signal: operation!.signal,
      onSendStarted: () => coordinator.markSending(operation!.token),
      resolveAssistantBinding: () => binding,
      encodeTurnContent: () => 'pending',
    })
    expect(coordinator.abortPreparation()).toBe('preparing')
    expect(coordinator.beginSubmission(4)).toBeNull()
    resolveBinding({
      assistantId: 'assistant-1',
      systemPrompt: '',
      enabledSkillNames: [],
    })

    await expect(submission).rejects.toMatchObject({ name: 'AbortError' })
    coordinator.finishSubmission(operation!.token)
    expect(ensureReady).not.toHaveBeenCalled()
    expect(sendTurn).not.toHaveBeenCalled()
    const nextOperation = coordinator.beginSubmission(4)
    expect(nextOperation).not.toBeNull()
    coordinator.finishSubmission(nextOperation!.token)
  })

  it('starts fresh sessions and hydrates an exact indexed session once', async () => {
    const indexedRef: CliSessionRef = {
      runtimeId: 'claude-code',
      nativeSessionId: 'claude-session',
    }
    const hydration: CliSessionHydration = {
      ref: indexedRef,
      messages: [],
    }
    const hydrateSession = jest.fn(async () => hydration)
    const controller = {
      hydrateSession,
      getSnapshot: () => cliSnapshot(),
    } as unknown as CliConversationController
    const selectConversationSession = jest.fn(() => controller)
    const recordOpenedSession = jest.fn(async () => undefined)
    const scope = {
      selectConversationSession,
      sessionService: {
        restoreUserDisplays: jest.fn(async (_ref, messages) => [...messages]),
        recordOpenedSession,
      },
    } as unknown as CliRuntimeScope

    const discoveryResult: CliSessionDiscoveryResult = {
      sessions: [
        {
          ref: indexedRef,
          title: 'Indexed',
          updatedAt: 1,
          hasOverlay: true,
          assistantId: 'assistant-overlay',
          isPinned: false,
        },
      ],
      errors: {},
    }
    const opened = await openCliSession({
      scope,
      ref: indexedRef,
      discoveryResult,
      currentAssistantId: 'assistant-current',
    })

    expect(selectConversationSession).toHaveBeenLastCalledWith(indexedRef)
    expect(hydrateSession).toHaveBeenCalledTimes(1)
    expect(hydrateSession).toHaveBeenCalledWith(
      indexedRef,
      expect.any(Function),
      'assistant-overlay',
    )
    expect(recordOpenedSession).toHaveBeenCalledWith(hydration, {
      assistantId: 'assistant-overlay',
    })
    expect(opened.assistantId).toBe('assistant-overlay')

    expect(shouldHydrateSeededCliSession(indexedRef, cliSnapshot())).toBe(true)
    expect(
      shouldHydrateSeededCliSession(
        indexedRef,
        cliSnapshot({ sessionRef: indexedRef }),
      ),
    ).toBe(false)
    expect(
      shouldHydrateSeededCliSession(
        indexedRef,
        cliSnapshot({
          sessionRef: {
            runtimeId: 'codex',
            nativeSessionId: 'controller-authoritative',
          },
        }),
      ),
    ).toBe(false)
  })

  it.each([
    ['loading YOLO history', 'navigation'],
    ['starting a new chat', 'navigation'],
    ['selecting another runtime', 'navigation'],
    ['selecting another CLI session', 'navigation'],
    ['submitting a YOLO retry or edit', 'submission'],
  ] as const)(
    'does not commit a stale CLI open after %s',
    async (_label, cause) => {
      const generation = { current: 0 }
      const ref: CliSessionRef = {
        runtimeId: 'codex',
        nativeSessionId: 'stale-open',
      }
      const hydration = deferred<CliSessionHydration | null>()
      const controller = {
        hydrateSession: jest.fn(() => hydration.promise),
        getSnapshot: () => cliSnapshot(),
      } as unknown as CliConversationController
      const recordOpenedSession = jest.fn(async () => {
        throw new Error('stale overlay failure')
      })
      const scope = {
        selectConversationSession: jest.fn(() => controller),
        sessionService: {
          restoreUserDisplays: jest.fn(async (_ref, messages) => [...messages]),
          recordOpenedSession,
        },
      } as unknown as CliRuntimeScope
      const commitRuntime = jest.fn()
      const showNotice = jest.fn()
      const isCurrentOpen = beginChatRuntimeNavigation(generation, () => true)

      const pendingOpen = (async () => {
        const result = await openCliSessionForNavigation({
          scope,
          ref,
          currentAssistantId: 'assistant-stale',
          isCurrent: isCurrentOpen,
        })
        if (!result) return
        commitRuntime(result.controller, result.assistantId)
        if (result.overlayError) showNotice(result.overlayError)
      })()

      if (cause === 'submission') {
        invalidateChatRuntimeNavigation(generation)
      } else {
        beginChatRuntimeNavigation(generation, () => true)
      }
      hydration.resolve({ ref, messages: [] })
      await pendingOpen

      expect(commitRuntime).not.toHaveBeenCalled()
      expect(showNotice).not.toHaveBeenCalled()
      expect(recordOpenedSession).not.toHaveBeenCalled()
    },
  )

  it('treats sendTurn success as accepted before a deferred overlay write', async () => {
    const overlay = deferred<undefined>()
    const ref: CliSessionRef = {
      runtimeId: 'codex',
      nativeSessionId: 'accepted-before-overlay',
    }
    const cancel = jest.fn(async () => undefined)
    const resetSession = jest.fn()
    const controller = {
      stageTurn: jest.fn((message: ChatUserMessage) => ({
        surfaceId: 'cli:codex:test',
        conversationEpoch: 0,
        userMessageId: message.id,
      })),
      rejectStagedTurn: jest.fn(),
      ensureReady: jest.fn(async () => undefined),
      sendTurn: jest.fn(async () => undefined),
      cancel,
      resetSession,
      getSnapshot: () => cliSnapshot({ sessionRef: ref, runState: 'running' }),
    } as unknown as CliConversationController
    const scope = {
      sessionService: {
        recordUserDisplay: jest.fn(async () => undefined),
        recordOpenedSession: jest.fn(() => overlay.promise),
      },
    } as unknown as CliRuntimeScope
    const coordinator = new CliChatOperationCoordinator()
    const operation = coordinator.beginSubmission(7)!

    const submission = submitCliComposerTurn({
      app: {} as never,
      settings: { assistants: [] } as unknown as YoloSettings,
      scope,
      controller,
      runtimeId: 'codex',
      assistantId: 'assistant-cli',
      userMessage: userMessage(),
      timeContextEnabled: false,
      signal: operation.signal,
      onSendStarted: () => coordinator.markSending(operation.token),
      onAccepted: (acceptedMessage) => {
        coordinator.markAccepted(operation.token, acceptedMessage)
      },
      resolveAssistantBinding: async () => ({
        assistantId: 'assistant-cli',
        systemPrompt: '',
        enabledSkillNames: [],
      }),
      encodeTurnContent: () => 'accepted content',
    })

    await waitUntil(
      () => coordinator.getSnapshot().submissionPhase === 'accepted',
    )
    await expect(coordinator.cancelCurrentOperation(controller)).resolves.toBe(
      undefined,
    )
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(resetSession).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot().submissionPhase).toBe('idle')
    expect(coordinator.getSnapshot().acceptedDraft).toMatchObject({
      draftRevision: 7,
      userMessage: { id: 'draft-1' },
    })

    overlay.resolve(undefined)
    await expect(submission).resolves.toMatchObject({ overlayError: null })
    coordinator.finishSubmission(operation.token)
  })

  it('does not cancel an active submission when navigating away', async () => {
    const coordinator = new CliChatOperationCoordinator()
    const operation = coordinator.beginSubmission(1)!
    expect(coordinator.markSending(operation.token)).toBe(true)
    const cancel = jest.fn(async () => undefined)
    const controller = {
      cancel,
      getSnapshot: () => cliSnapshot(),
    } as unknown as CliConversationController
    const action = jest.fn()

    const transition = coordinator.transition(controller, action)
    await expect(transition).resolves.toBe(true)
    expect(cancel).not.toHaveBeenCalled()
    expect(action).toHaveBeenCalledTimes(1)
    coordinator.finishSubmission(operation.token)
  })

  it('blocks a replacement submit until stopping preparation has reset the controller', async () => {
    const cancellation = deferred<undefined>()
    const resetSession = jest.fn()
    const controller = {
      cancel: jest.fn(() => cancellation.promise),
      resetSession,
      getSnapshot: () => cliSnapshot(),
    } as unknown as CliConversationController
    const coordinator = new CliChatOperationCoordinator()
    coordinator.beginSubmission(1)

    const stopping = coordinator.cancelCurrentOperation(controller)
    expect(coordinator.getSnapshot().isTransitioning).toBe(true)
    expect(coordinator.beginSubmission(2)).toBeNull()

    cancellation.resolve(undefined)
    await expect(stopping).resolves.toBeUndefined()
    expect(resetSession).toHaveBeenCalledTimes(1)
    expect(coordinator.getSnapshot().isTransitioning).toBe(false)
    const replacement = coordinator.beginSubmission(2)
    expect(replacement).not.toBeNull()
    coordinator.finishSubmission(replacement!.token)
  })

  it('navigates without consulting cancellation state', async () => {
    const cancellationError = new Error('cancel failed')
    const resetSession = jest.fn()
    const cancel = jest.fn(async () => {
      throw cancellationError
    })
    const controller = {
      cancel,
      getSnapshot: () =>
        cliSnapshot({
          sessionRef: { runtimeId: 'codex', nativeSessionId: 'current' },
        }),
      resetSession,
    } as unknown as CliConversationController
    const coordinator = new CliChatOperationCoordinator()
    const action = jest.fn()

    await expect(coordinator.transition(controller, action)).resolves.toBe(true)
    expect(action).toHaveBeenCalledTimes(1)
    expect(cancel).not.toHaveBeenCalled()
    expect(resetSession).not.toHaveBeenCalled()
  })

  it('lets only the latest transition mutate session state', async () => {
    const cancel = jest.fn(async () => undefined)
    const controller = {
      cancel,
      getSnapshot: () =>
        cliSnapshot({
          sessionRef: { runtimeId: 'codex', nativeSessionId: 'current' },
        }),
    } as unknown as CliConversationController
    const coordinator = new CliChatOperationCoordinator()
    const firstAction = jest.fn()
    const latestAction = jest.fn()

    const first = coordinator.transition(controller, firstAction)
    const latest = coordinator.transition(controller, latestAction)
    await expect(first).resolves.toBe(false)
    await expect(latest).resolves.toBe(true)
    expect(firstAction).not.toHaveBeenCalled()
    expect(latestAction).toHaveBeenCalledTimes(1)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('clears only the accepted draft revision and opens current YOLO history from CLI', () => {
    const acceptedDraft = {
      token: 1,
      draftRevision: 4,
      userMessage: userMessage(),
    }
    expect(
      shouldClearAcceptedCliDraft({
        acceptedDraft,
        currentDraft: userMessage(),
        currentDraftRevision: 4,
      }),
    ).toBe(true)
    expect(
      shouldClearAcceptedCliDraft({
        acceptedDraft,
        currentDraft: userMessage(),
        currentDraftRevision: 5,
      }),
    ).toBe(false)
    expect(
      shouldClearAcceptedCliDraft({
        acceptedDraft,
        currentDraft: { ...userMessage(), id: 'draft-2' },
        currentDraftRevision: 4,
      }),
    ).toBe(false)

    expect(
      shouldLoadYoloHistoryItem({
        activeRuntimeId: 'codex',
        conversationId: 'underlying-yolo',
        currentConversationId: 'underlying-yolo',
      }),
    ).toBe(true)
    expect(
      shouldLoadYoloHistoryItem({
        activeRuntimeId: 'yolo',
        conversationId: 'underlying-yolo',
        currentConversationId: 'underlying-yolo',
      }),
    ).toBe(false)
  })

  it('binds an external session to the current assistant and records its overlay', async () => {
    const ref: CliSessionRef = {
      runtimeId: 'codex',
      nativeSessionId: 'external-session',
    }
    const hydration = { ref, messages: [] }
    const controller = {
      hydrateSession: jest.fn(async () => hydration),
      getSnapshot: () => cliSnapshot(),
    } as unknown as CliConversationController
    const recordOpenedSession = jest.fn(async () => undefined)
    const scope = {
      selectConversationSession: jest.fn(() => controller),
      sessionService: {
        restoreUserDisplays: jest.fn(async (_ref, messages) => [...messages]),
        recordOpenedSession,
      },
    } as unknown as CliRuntimeScope

    const result = await openCliSession({
      scope,
      ref,
      discoveryResult: {
        sessions: [
          {
            ref,
            title: 'External',
            updatedAt: 1,
            hasOverlay: false,
            isPinned: false,
          },
        ],
        errors: {},
      },
      currentAssistantId: 'assistant-current',
    })

    expect(result.assistantId).toBe('assistant-current')
    expect(recordOpenedSession).toHaveBeenCalledWith(hydration, {
      assistantId: 'assistant-current',
    })
  })

  it('never removes an overlay before explicit confirmation', async () => {
    let confirm: (() => void) | undefined
    let cancel: (() => void) | undefined
    const removeOverlay = jest.fn(async () => true)
    const pending = removeCliOverlayAfterConfirmation({
      requestConfirmation: (onConfirm, onCancel) => {
        confirm = onConfirm
        cancel = onCancel
      },
      removeOverlay,
    })

    expect(removeOverlay).not.toHaveBeenCalled()
    confirm?.()
    await expect(pending).resolves.toBe(true)
    expect(removeOverlay).toHaveBeenCalledTimes(1)

    const cancelled = removeCliOverlayAfterConfirmation({
      requestConfirmation: (_onConfirm, onCancel) => {
        cancel = onCancel
      },
      removeOverlay,
    })
    cancel?.()
    await expect(cancelled).resolves.toBe(false)
    expect(removeOverlay).toHaveBeenCalledTimes(1)
  })
})
