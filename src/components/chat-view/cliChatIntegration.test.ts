import type { SerializedEditorState } from 'lexical'

import type {
  CliConversationController,
  CliConversationSnapshot,
  CliRuntimeScope,
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
  isCliConversationActive,
  openCliSession,
  openCliSessionForNavigation,
  prepareCliConversation,
  resolveActiveCliConversationSnapshot,
  resolveChatRuntimeId,
  resolveHermesProfileSwitchAction,
  resolveHermesSessionFallbackUpdate,
  rewriteCliConversationTurn,
  shouldClearAcceptedCliDraft,
  shouldHydrateSeededCliSession,
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

const environmentContext = [
  { type: 'text' as const, text: '<focused_context>spec.md</focused_context>' },
]

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
  compactionBoundaries: [],
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
    const updatePermissionProfile = jest.fn(async () => undefined)
    const controller = {
      stageTurn: jest.fn((message: ChatUserMessage) => ({
        surfaceId: 'cli:codex:test',
        conversationEpoch: 0,
        userMessageId: message.id,
      })),
      rejectStagedTurn: jest.fn(),
      ensureReady,
      updatePermissionProfile,
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
    await prepareCliConversation({
      controller,
      scope,
      runtimeId: 'codex',
      settings,
      permissionProfile: { mode: 'agent', yoloEnabled: true },
    })

    expect(updatePermissionProfile).toHaveBeenCalledWith({
      mode: 'agent',
      yoloEnabled: true,
    })
    expect(updatePermissionProfile.mock.invocationCallOrder[0]).toBeLessThan(
      ensureReady.mock.invocationCallOrder[0],
    )
    expect(ensureReady).toHaveBeenCalledWith({
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
      compactionBoundaries: [],
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
    expect(isCliConversationActive(cliSnapshot)).toBe(false)
    expect(
      isCliConversationActive({ ...cliSnapshot, isCompacting: true }),
    ).toBe(true)
    expect(resolveActiveCliConversationSnapshot('yolo', cliSnapshot)).toBeNull()
  })

  it('encodes and submits the CLI draft through the native runtime', async () => {
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
    await submitCliComposerTurn({
      settings: parseYoloSettings({ version: SETTINGS_SCHEMA_VERSION }),
      scope,
      controller,
      runtimeId: 'codex',
      userMessage: userMessage(),
      environmentContext,
      encodeTurnContent,
    })

    expect(encodeTurnContent).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: 'codex',
        text: 'Run the focused task',
        mentionables: expect.any(Array),
        selectedSkills: expect.any(Array),
        timeContext: '2026-07-30 14:53 (Thursday)',
        environmentContext,
      }),
    )
    expect(ensureReady).toHaveBeenCalledWith({})
    expect(sendTurn).toHaveBeenCalledWith({
      userMessage: expect.objectContaining({
        id: 'draft-1',
        promptContent: null,
      }),
      content: 'encoded CLI content',
      selectedSkills: [
        {
          name: 'review',
          description: 'Review changes',
          path: 'review',
        },
      ],
    })
    expect(recordOpenedSession).toHaveBeenCalledWith({
      ref,
      messages: [],
      compactionBoundaries: [],
    })
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
        settings: { assistants: [] } as unknown as YoloSettings,
        scope,
        controller,
        runtimeId: 'codex',
        userMessage: userMessage(),
        environmentContext,
        encodeTurnContent: () => 'accepted',
      }),
    ).resolves.toEqual({
      sessionRef: ref,
      userMessage: expect.objectContaining({
        id: 'draft-1',
        timeContext: expect.any(String),
      }),
      overlayError,
    })
  })

  it('aborts an unmounted preparation before it can reach sendTurn', async () => {
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const ensureReady = jest.fn(() => ready)
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
      getSnapshot: () => cliSnapshot(),
    } as unknown as CliConversationController

    const coordinator = new CliChatOperationCoordinator()
    const operation = coordinator.beginSubmission(3)
    expect(operation).not.toBeNull()

    const submission = submitCliComposerTurn({
      settings: parseYoloSettings({ version: SETTINGS_SCHEMA_VERSION }),
      scope: {
        getModelCatalogSnapshot: () => new Map(),
      } as unknown as CliRuntimeScope,
      controller,
      runtimeId: 'codex',
      userMessage: userMessage(),
      environmentContext,
      signal: operation!.signal,
      onSendStarted: () => coordinator.markSending(operation!.token),
      encodeTurnContent: () => 'pending',
    })
    expect(coordinator.abortPreparation()).toBe('preparing')
    expect(coordinator.beginSubmission(4)).toBeNull()
    resolveReady()

    await expect(submission).rejects.toMatchObject({ name: 'AbortError' })
    coordinator.finishSubmission(operation!.token)
    expect(ensureReady).toHaveBeenCalledTimes(1)
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
      compactionBoundaries: [],
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
        restoreSessionOverlay: jest.fn(async (_ref, messages) => ({
          messages: [...messages],
          turnConfigurationByUserMessageId: {},
        })),
        recordOpenedSession,
      },
    } as unknown as CliRuntimeScope

    const opened = await openCliSession({
      scope,
      ref: indexedRef,
    })

    expect(selectConversationSession).toHaveBeenLastCalledWith(indexedRef)
    expect(hydrateSession).toHaveBeenCalledTimes(1)
    expect(hydrateSession).toHaveBeenCalledWith(
      indexedRef,
      expect.any(Function),
    )
    expect(recordOpenedSession).toHaveBeenCalledWith(hydration)
    expect(opened.controller).toBe(controller)

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
          restoreSessionOverlay: jest.fn(async (_ref, messages) => ({
            messages: [...messages],
            turnConfigurationByUserMessageId: {},
          })),
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
          isCurrent: isCurrentOpen,
        })
        if (!result) return
        commitRuntime(result.controller)
        if (result.overlayError) showNotice(result.overlayError)
      })()

      if (cause === 'submission') {
        invalidateChatRuntimeNavigation(generation)
      } else {
        beginChatRuntimeNavigation(generation, () => true)
      }
      hydration.resolve({ ref, messages: [], compactionBoundaries: [] })
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
      settings: { assistants: [] } as unknown as YoloSettings,
      scope,
      controller,
      runtimeId: 'codex',
      userMessage: userMessage(),
      environmentContext,
      signal: operation.signal,
      onSendStarted: () => coordinator.markSending(operation.token),
      onAccepted: (acceptedMessage) => {
        coordinator.markAccepted(operation.token, acceptedMessage)
      },
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

  it('clears only the accepted draft revision', () => {
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
  })

  it('resolves the Hermes profile-switch action from conversation state', () => {
    // Not on Hermes: always a no-op regardless of message state.
    expect(
      resolveHermesProfileSwitchAction({
        activeRuntimeId: 'codex',
        requestedProfileId: 'work',
        currentProfileId: undefined,
        hasMessages: true,
      }),
    ).toBe('noop')

    // Already on the requested profile: no-op.
    expect(
      resolveHermesProfileSwitchAction({
        activeRuntimeId: 'hermes',
        requestedProfileId: 'work',
        currentProfileId: 'work',
        hasMessages: false,
      }),
    ).toBe('noop')
    expect(
      resolveHermesProfileSwitchAction({
        activeRuntimeId: 'hermes',
        requestedProfileId: undefined,
        currentProfileId: undefined,
        hasMessages: true,
      }),
    ).toBe('noop')

    // Empty conversation: swap the profile in place.
    expect(
      resolveHermesProfileSwitchAction({
        activeRuntimeId: 'hermes',
        requestedProfileId: 'work',
        currentProfileId: undefined,
        hasMessages: false,
      }),
    ).toBe('swap-in-place')

    // Conversation already has messages: start a brand new conversation,
    // never migrate history onto the new profile.
    expect(
      resolveHermesProfileSwitchAction({
        activeRuntimeId: 'hermes',
        requestedProfileId: 'work',
        currentProfileId: undefined,
        hasMessages: true,
      }),
    ).toBe('new-conversation')
    expect(
      resolveHermesProfileSwitchAction({
        activeRuntimeId: 'hermes',
        requestedProfileId: undefined,
        currentProfileId: 'work',
        hasMessages: true,
      }),
    ).toBe('new-conversation')
  })

  describe('resolveHermesSessionFallbackUpdate', () => {
    // These take the shape `CliConversationController.getSnapshot()` settles
    // into after both `hydrateSession()` and `ensureReady()` have run (see
    // `conversation-controller.test.ts`'s "session recovery fallback" suite
    // for how the controller itself derives `sessionFallbackBoundaries`) —
    // not the one-shot `CliSessionHydration` `openSession()` alone returns.
    const fallbackBoundary = (requestedRef: CliSessionRef) => ({
      id: 'fallback-boundary',
      afterMessageId: null,
      requestedRef,
    })

    it('returns null for a non-Hermes runtime, even with a fallback-shaped snapshot', () => {
      const snapshot: Pick<
        CliConversationSnapshot,
        'sessionRef' | 'sessionFallbackBoundaries'
      > = {
        sessionRef: { runtimeId: 'codex', nativeSessionId: 'fresh-sess' },
        sessionFallbackBoundaries: [
          fallbackBoundary({
            runtimeId: 'codex',
            nativeSessionId: 'gone-sess',
          }),
        ],
      }
      expect(resolveHermesSessionFallbackUpdate('codex', snapshot)).toBeNull()
    })

    it('returns null when no session is bound yet', () => {
      const snapshot: Pick<
        CliConversationSnapshot,
        'sessionRef' | 'sessionFallbackBoundaries'
      > = {
        sessionRef: null,
        sessionFallbackBoundaries: [],
      }
      expect(resolveHermesSessionFallbackUpdate('hermes', snapshot)).toBeNull()
    })

    it('returns null when the bound session carries no fallback boundary', () => {
      const snapshot: Pick<
        CliConversationSnapshot,
        'sessionRef' | 'sessionFallbackBoundaries'
      > = {
        sessionRef: {
          runtimeId: 'hermes',
          nativeSessionId: 'sess-1',
          profileId: 'work',
        },
        sessionFallbackBoundaries: [],
      }
      expect(resolveHermesSessionFallbackUpdate('hermes', snapshot)).toBeNull()
    })

    it('resets hermesProfileId to the default (undefined) and builds a default-profile cliSession when a fallback occurred', () => {
      const snapshot: Pick<
        CliConversationSnapshot,
        'sessionRef' | 'sessionFallbackBoundaries'
      > = {
        sessionRef: { runtimeId: 'hermes', nativeSessionId: 'fallback-sess' },
        sessionFallbackBoundaries: [
          fallbackBoundary({
            runtimeId: 'hermes',
            nativeSessionId: 'gone-sess',
            profileId: 'deleted-profile',
          }),
        ],
      }
      expect(resolveHermesSessionFallbackUpdate('hermes', snapshot)).toEqual({
        hermesProfileId: undefined,
        cliSession: {
          runtimeId: 'hermes',
          nativeSessionId: 'fallback-sess',
        },
      })
    })

    it('carries sessionPathHint through, but never a stale profileId, when the bound ref has one', () => {
      const snapshot: Pick<
        CliConversationSnapshot,
        'sessionRef' | 'sessionFallbackBoundaries'
      > = {
        sessionRef: {
          runtimeId: 'hermes',
          nativeSessionId: 'fallback-sess',
          sessionPathHint: '/vault/.yolo/hermes/fallback-sess',
        },
        sessionFallbackBoundaries: [
          fallbackBoundary({
            runtimeId: 'hermes',
            nativeSessionId: 'gone-sess',
            profileId: 'deleted-profile',
          }),
        ],
      }
      const update = resolveHermesSessionFallbackUpdate('hermes', snapshot)
      expect(update?.cliSession).toEqual({
        runtimeId: 'hermes',
        nativeSessionId: 'fallback-sess',
        sessionPathHint: '/vault/.yolo/hermes/fallback-sess',
      })
      expect(update?.cliSession).not.toHaveProperty('profileId')
    })

    // Regression for the bug where only the *first* load's hydration was
    // consulted: the requested profile's session resumed cleanly at
    // `openSession()` time (no fallback there), and only the *second*,
    // separate load inside `prepareCliConversation()`'s `ensureReady()`
    // discovered the profile was gone in the meantime (deleted between the
    // two loads, or the host process crashed and respawned). The controller
    // still records that as a fallback boundary against the *current*
    // sessionRef, so reading its settled snapshot — not the stale
    // first-load hydration — must still catch it.
    it('catches a fallback recorded only by the second (ensureReady) load, not the first (openSession) one', () => {
      const requestedRef: CliSessionRef = {
        runtimeId: 'hermes',
        nativeSessionId: 'original-sess',
        profileId: 'work',
      }
      const snapshotAfterFirstLoadAlone: Pick<
        CliConversationSnapshot,
        'sessionRef' | 'sessionFallbackBoundaries'
      > = {
        // openSession() bound the exact session that was requested — no
        // fallback yet.
        sessionRef: requestedRef,
        sessionFallbackBoundaries: [],
      }
      expect(
        resolveHermesSessionFallbackUpdate(
          'hermes',
          snapshotAfterFirstLoadAlone,
        ),
      ).toBeNull()

      const snapshotAfterEnsureReady: Pick<
        CliConversationSnapshot,
        'sessionRef' | 'sessionFallbackBoundaries'
      > = {
        // ensureReady()'s own load then failed on the same requested ref and
        // fell back live to a fresh default-profile session.
        sessionRef: { runtimeId: 'hermes', nativeSessionId: 'second-fallback' },
        sessionFallbackBoundaries: [fallbackBoundary(requestedRef)],
      }
      expect(
        resolveHermesSessionFallbackUpdate('hermes', snapshotAfterEnsureReady),
      ).toEqual({
        hermesProfileId: undefined,
        cliSession: {
          runtimeId: 'hermes',
          nativeSessionId: 'second-fallback',
        },
      })
    })
  })

  it('opens an external native session and records its overlay', async () => {
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
        restoreSessionOverlay: jest.fn(async (_ref, messages) => ({
          messages: [...messages],
          turnConfigurationByUserMessageId: {},
        })),
        recordOpenedSession,
      },
    } as unknown as CliRuntimeScope

    const result = await openCliSession({
      scope,
      ref,
    })

    expect(result.controller).toBe(controller)
    expect(recordOpenedSession).toHaveBeenCalledWith(hydration)
  })

  it('rewrites the current CLI history and moves overlays to a rebound session', async () => {
    const previousRef: CliSessionRef = {
      runtimeId: 'claude-code',
      nativeSessionId: 'session-old',
    }
    const nextRef: CliSessionRef = {
      runtimeId: 'claude-code',
      nativeSessionId: 'session-new',
    }
    const first = { ...userMessage(), id: 'user-1' }
    const target = { ...userMessage(), id: 'user-2' }
    let snapshot = cliSnapshot({
      runtimeId: 'claude-code',
      sessionRef: previousRef,
      messages: [
        first,
        { role: 'assistant', id: 'assistant-1', content: 'first answer' },
        target,
        { role: 'assistant', id: 'assistant-2', content: 'old answer' },
      ],
    })
    const rewriteTurn = jest.fn(async () => {
      snapshot = {
        ...snapshot,
        sessionRef: nextRef,
        messages: [first, target],
        runState: 'running',
      }
    })
    const ensureReady = jest.fn(async () => undefined)
    const updateConfiguration = jest.fn(async () => {
      const configuration = {
        models: [],
        modelId: 'claude-sonnet',
        reasoningEffort: 'high',
      }
      snapshot = { ...snapshot, configuration }
      return configuration
    })
    const controller = {
      getSnapshot: () => snapshot,
      ensureReady,
      updateConfiguration,
      rewriteTurn,
    } as unknown as CliConversationController
    const rebindOverlay = jest.fn(async () => undefined)
    const recordUserDisplay = jest.fn(async () => undefined)
    const scope = {
      sessionService: {
        getRememberedConfiguration: jest.fn(async () => ({})),
        rebindOverlay,
        recordUserDisplay,
        recordOpenedSession: jest.fn(async () => undefined),
      },
    } as unknown as CliRuntimeScope

    const result = await rewriteCliConversationTurn({
      settings: parseYoloSettings({ version: SETTINGS_SCHEMA_VERSION }),
      scope,
      controller,
      runtimeId: 'claude-code',
      sourceUserMessageId: 'user-2',
      userMessage: target,
      environmentContext,
      configuration: {
        modelId: 'claude-sonnet',
        reasoningEffort: 'high',
      },
      encodeTurnContent: () => 'edited transport',
    })

    expect(result.sessionRef).toBe(nextRef)
    expect(ensureReady).toHaveBeenCalledTimes(1)
    expect(updateConfiguration).toHaveBeenCalledWith({
      modelId: 'claude-sonnet',
      reasoningEffort: 'high',
    })
    expect(ensureReady.mock.invocationCallOrder[0]).toBeLessThan(
      rewriteTurn.mock.invocationCallOrder[0],
    )
    expect(rewriteTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUserMessageId: 'user-2' }),
    )
    expect(rebindOverlay).toHaveBeenCalledWith(previousRef, nextRef, ['user-2'])
    expect(recordUserDisplay).toHaveBeenCalledWith(
      nextRef,
      'edited transport',
      expect.objectContaining({
        id: target.id,
        timeContext: expect.any(String),
      }),
      { modelId: 'claude-sonnet', reasoningEffort: 'high' },
    )
  })
})
