import type { SerializedEditorState } from 'lexical'

import type {
  CliConversationController,
  CliRuntimeScope,
  CliSessionDiscoveryResult,
  CliSessionHydration,
  CliSessionRef,
} from '../../core/cli-runtime'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ChatUserMessage } from '../../types/chat'

import {
  dispatchComposerSubmit,
  openCliSession,
  removeCliOverlayAfterConfirmation,
  resetCliSessionForAssistantChange,
  resolveActiveCliConversationSnapshot,
  resolveChatRuntimeId,
  selectFreshCliRuntime,
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

describe('CLI chat integration', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('falls back to YOLO without a desktop scope and restores a seeded desktop runtime', () => {
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
  })

  it('dispatches a CLI draft without invoking the YOLO submit path', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 6, 30, 14, 53))
    const ref: CliSessionRef = {
      runtimeId: 'codex',
      nativeSessionId: 'native-1',
    }
    const ensureReady = jest.fn(async () => undefined)
    const sendTurn = jest.fn(async () => undefined)
    const recordOpenedSession = jest.fn(async () => undefined)
    const controller = {
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
      sessionService: { recordOpenedSession },
    } as unknown as CliRuntimeScope
    const submitYolo = jest.fn()
    const encodeTurnContent = jest.fn(() => 'encoded CLI content')
    const resolveAssistantBinding = jest.fn(async () => ({
      assistantId: 'assistant-1',
      systemPrompt: 'Be precise.',
      enabledSkillNames: ['review'],
    }))

    await dispatchComposerSubmit({
      runtimeId: 'codex',
      submitYolo,
      submitCli: (runtimeId) =>
        submitCliComposerTurn({
          app: {} as never,
          settings: { assistants: [] } as unknown as YoloSettings,
          scope,
          controller,
          runtimeId,
          assistantId: 'assistant-1',
          userMessage: userMessage(),
          timeContextEnabled: true,
          resolveAssistantBinding,
          encodeTurnContent,
        }),
    })

    expect(submitYolo).not.toHaveBeenCalled()
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
    )
    expect(sendTurn).toHaveBeenCalledWith({
      userMessage: expect.objectContaining({
        id: 'draft-1',
        promptContent: 'encoded CLI content',
      }),
      content: 'encoded CLI content',
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

  it('stops a pending CLI submit before the controller accepts the turn', async () => {
    const abortController = new AbortController()
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
      ensureReady,
      sendTurn,
    } as unknown as CliConversationController

    const submission = submitCliComposerTurn({
      app: {} as never,
      settings: { assistants: [] } as unknown as YoloSettings,
      scope: {} as CliRuntimeScope,
      controller,
      runtimeId: 'codex',
      assistantId: 'assistant-1',
      userMessage: userMessage(),
      timeContextEnabled: false,
      signal: abortController.signal,
      resolveAssistantBinding: () => binding,
      encodeTurnContent: () => 'pending',
    })
    abortController.abort()
    resolveBinding({
      assistantId: 'assistant-1',
      systemPrompt: '',
      enabledSkillNames: [],
    })

    await expect(submission).rejects.toMatchObject({ name: 'AbortError' })
    expect(ensureReady).not.toHaveBeenCalled()
    expect(sendTurn).not.toHaveBeenCalled()
  })

  it('starts fresh sessions, hydrates an exact indexed session once, and resets on assistant change', async () => {
    const indexedRef: CliSessionRef = {
      runtimeId: 'claude-code',
      nativeSessionId: 'claude-session',
    }
    const hydration: CliSessionHydration = {
      ref: indexedRef,
      messages: [],
    }
    const resetSession = jest.fn()
    const hydrateSession = jest.fn(async () => hydration)
    const controller = {
      resetSession,
      hydrateSession,
    } as unknown as CliConversationController
    const selectConversationRuntime = jest.fn(() => controller)
    const recordOpenedSession = jest.fn(async () => undefined)
    const scope = {
      selectConversationRuntime,
      sessionService: { recordOpenedSession },
    } as unknown as CliRuntimeScope

    expect(selectFreshCliRuntime(scope, 'codex')).toBe(controller)
    expect(selectConversationRuntime).toHaveBeenLastCalledWith('codex')
    expect(resetSession).toHaveBeenCalledTimes(1)

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

    expect(selectConversationRuntime).toHaveBeenLastCalledWith('claude-code')
    expect(hydrateSession).toHaveBeenCalledTimes(1)
    expect(hydrateSession).toHaveBeenCalledWith(indexedRef)
    expect(recordOpenedSession).toHaveBeenCalledWith(hydration, {
      assistantId: 'assistant-overlay',
    })
    expect(opened.assistantId).toBe('assistant-overlay')

    expect(
      resetCliSessionForAssistantChange({
        activeRuntimeId: 'claude-code',
        controller,
        currentAssistantId: 'assistant-overlay',
        nextAssistantId: 'assistant-new',
      }),
    ).toBe(true)
    expect(resetSession).toHaveBeenCalledTimes(2)
    expect(
      resetCliSessionForAssistantChange({
        activeRuntimeId: 'yolo',
        controller,
        currentAssistantId: 'assistant-new',
        nextAssistantId: 'assistant-other',
      }),
    ).toBe(false)
    expect(resetSession).toHaveBeenCalledTimes(2)
  })

  it('binds an external session to the current assistant and records its overlay', async () => {
    const ref: CliSessionRef = {
      runtimeId: 'codex',
      nativeSessionId: 'external-session',
    }
    const hydration = { ref, messages: [] }
    const controller = {
      hydrateSession: jest.fn(async () => hydration),
    } as unknown as CliConversationController
    const recordOpenedSession = jest.fn(async () => undefined)
    const scope = {
      selectConversationRuntime: jest.fn(() => controller),
      sessionService: { recordOpenedSession },
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
