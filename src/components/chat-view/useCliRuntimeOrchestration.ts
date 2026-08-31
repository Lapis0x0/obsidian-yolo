import { App, Notice, TFile } from 'obsidian'
import {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { v4 as uuidv4 } from 'uuid'

import {
  type ChatRuntimeActions,
  type ChatRuntimeApprovalAction,
  type ChatRuntimeId,
  type CliChatMode,
  type CliConversationController,
  type CliConversationSnapshot,
  type CliRuntimeConfiguration,
  type CliRuntimeId,
  type CliRuntimeModel,
  type CliRuntimeScope,
  type CliSessionRef,
  type CliTurnConfiguration,
  RUNTIME_CAPABILITIES,
  buildCliEnvironmentContext,
  isCliRuntime,
  syncNativeConversationTitle,
} from '../../core/cli-runtime'
import { CLAUDE_EXIT_PLAN_MODE_TOOL } from '../../core/cli-runtime/claude/exitPlanMode'
import type { LiteSkillEntry } from '../../core/skills/liteSkills'
import type { useChatHistory } from '../../hooks/useChatHistory'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ChatUserMessage } from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type { CurrentFileViewState, Mentionable } from '../../types/mentionable'
import type { ReasoningLevel } from '../../types/reasoning'
import { AcknowledgementModal } from '../modals/AcknowledgementModal'

import {
  type ChatModeSelectValue,
  isModuleChatMode,
} from './chat-input/ChatModeSelect'
import {
  type CliChatOperationSnapshot,
  getCliChatOperationCoordinator,
  isCliConversationActive,
  openCliSession,
  prepareCliConversation,
  registerCliConversationProfileId,
  resolveActiveCliConversationSnapshot,
  resolveCliSessionRefProfileId,
  resolveHermesProfileSwitchAction,
  resolveHermesSessionFallbackUpdate,
  rewriteCliConversationTurn,
  shouldClearAcceptedCliDraft,
  shouldHydrateSeededCliSession,
} from './cliChatIntegration'
import {
  type CliModePreference,
  type PrePlanCliModeMemory,
  normalizeCliModeForRuntime,
  patchConversationCliModeOverrides,
  prunePrePlanCliMode,
  readPrePlanCliMode,
  rememberCliModePreference,
  rememberCliRuntimeConfiguration,
  rememberPrePlanCliMode,
  resolveCliRuntimePreference,
} from './cliRuntimePreferences'

function useLatestRef<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

export type UseCliRuntimeOrchestrationParams = {
  app: App
  t: (keyPath: string, fallback?: string) => string
  settings: YoloSettings
  updateSettings: (
    updater: (current: YoloSettings) => YoloSettings,
  ) => Promise<boolean>
  cliRuntimeScope: CliRuntimeScope | undefined
  getConversationById: ReturnType<typeof useChatHistory>['getConversationById']
  createOrTouchCliConversation: ReturnType<
    typeof useChatHistory
  >['createOrTouchCliConversation']

  // 运行时切换相关状态：暂时由 Chat.tsx 透传，待后续 useChatRuntimeSwitch 收拢
  activeRuntimeId: ChatRuntimeId
  initialActiveRuntimeId: ChatRuntimeId
  initialCliModePreference: CliModePreference
  activeRuntimeIdRef: MutableRefObject<ChatRuntimeId>
  setRequestedRuntimeId: Dispatch<SetStateAction<ChatRuntimeId>>
  lastCliRuntimeIdRef: MutableRefObject<CliRuntimeId>
  cliModeRequestGenerationRef: MutableRefObject<number>
  prePlanCliModeByConversationRef: PrePlanCliModeMemory
  chatMountedRef: MutableRefObject<boolean>
  seededCliSessionRef: CliSessionRef | null | undefined
  seededCliConversationId: string | null | undefined

  // 会话身份 / 每会话覆盖设置：与 Yolo 会话共享，由 Chat.tsx 持有
  currentConversationId: string
  conversationOverrides: ConversationOverrideSettings | null
  setConversationOverrides: Dispatch<
    SetStateAction<ConversationOverrideSettings | null>
  >
  conversationOverridesRef: MutableRefObject<
    Map<string, ConversationOverrideSettings | null>
  >

  // 输入控制器相关回调：步骤 3（useChatInputController）落地前的临时透传
  reasoningLevel: ReasoningLevel
  getLatestInputMessage: () => ChatUserMessage
  replaceInputMessage: (message: ChatUserMessage) => void
  buildNewInputMessage: (reasoningLevel: ReasoningLevel) => ChatUserMessage
  commitSentSelectionHighlights: (mentionables: Mentionable[]) => void
  inputDraftRevisionRef: MutableRefObject<number>

  // 当前文件上下文：CLI 消息改写时构建环境上下文使用
  activeFile: TFile | null
  activeViewState: CurrentFileViewState | undefined
}

/**
 * CLI 运行时编排：controller/操作协调器快照订阅、会话恢复、CLI mode/yolo 偏好、
 * CLI 模型与推理强度、CLI 用户消息改写等。纯 React 状态投影 —— 不触碰
 * cliChatIntegration.ts / cli-runtime 层的实现。
 */
export function useCliRuntimeOrchestration({
  app,
  t,
  settings,
  updateSettings,
  cliRuntimeScope,
  getConversationById,
  createOrTouchCliConversation,
  activeRuntimeId,
  initialActiveRuntimeId,
  initialCliModePreference,
  activeRuntimeIdRef,
  setRequestedRuntimeId,
  lastCliRuntimeIdRef,
  cliModeRequestGenerationRef,
  prePlanCliModeByConversationRef,
  chatMountedRef,
  seededCliSessionRef,
  seededCliConversationId,
  currentConversationId,
  conversationOverrides,
  setConversationOverrides,
  conversationOverridesRef,
  reasoningLevel,
  getLatestInputMessage,
  replaceInputMessage,
  buildNewInputMessage,
  commitSentSelectionHighlights,
  inputDraftRevisionRef,
  activeFile,
  activeViewState,
}: UseCliRuntimeOrchestrationParams) {
  const cliPreferenceSettingsRef = useRef(settings)
  useEffect(() => {
    cliPreferenceSettingsRef.current = settings
  }, [settings])

  const syncCliConversationTitle = useCallback(
    (conversationId: string, title: string) => {
      if (!cliRuntimeScope) return
      void getConversationById(conversationId)
        .then((conversation) => {
          if (!conversation?.cliSession) return
          syncNativeConversationTitle({
            sessionRef: conversation.cliSession,
            title,
            resolveRuntime: (runtimeId) =>
              cliRuntimeScope.resolveRuntime(runtimeId),
          })
        })
        .catch((error: unknown) => {
          console.warn('[YOLO] Failed to resolve CLI conversation title sync', {
            conversationId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    },
    [cliRuntimeScope, getConversationById],
  )

  const [cliChatMode, setCliChatMode] = useState<CliChatMode>(
    () => initialCliModePreference.mode,
  )
  const [cliYoloEnabled, setCliYoloEnabled] = useState<boolean>(
    () => initialCliModePreference.yoloEnabled,
  )
  const cliPermissionProfileRef = useLatestRef({
    mode: cliChatMode,
    yoloEnabled: cliChatMode === 'plan' ? false : cliYoloEnabled,
  })

  const [cliConversationController, setCliConversationController] =
    useState<CliConversationController | null>(() => {
      const controller =
        initialActiveRuntimeId !== 'yolo' && cliRuntimeScope
          ? seededCliSessionRef?.runtimeId === initialActiveRuntimeId
            ? cliRuntimeScope.selectConversationSession(seededCliSessionRef)
            : cliRuntimeScope.selectConversationRuntime(initialActiveRuntimeId)
          : null
      if (
        controller &&
        !controller.getSnapshot().sessionRef &&
        !controller.getSnapshot().configuration
      ) {
        controller.stageConfiguration(
          resolveCliRuntimePreference(
            settings,
            initialActiveRuntimeId as CliRuntimeId,
            cliRuntimeScope
              ?.getModelCatalogSnapshot()
              .get(initialActiveRuntimeId as CliRuntimeId) ?? [],
          ),
        )
      }
      return controller
    })
  const [cliConversationId, setCliConversationId] = useState<string | null>(
    () =>
      seededCliConversationId ?? (cliConversationController ? uuidv4() : null),
  )
  // Which Hermes profile the current conversation is (or will be, once a
  // session binds) tied to. `undefined` means the default profile — the
  // whole feature is designed so a single-profile user never has this
  // state deviate from "undefined", matching `CliSessionRef.profileId`'s
  // own convention. Synced from a resumed session's stored profile on
  // seeded restore / history load (see `setHermesProfileId` below), and
  // set explicitly by `switchHermesProfile`.
  const [hermesProfileId, setHermesProfileId] = useState<string | undefined>(
    () =>
      initialActiveRuntimeId === 'hermes'
        ? seededCliSessionRef?.profileId
        : undefined,
  )
  const [cliConversationSnapshot, setCliConversationSnapshot] =
    useState<CliConversationSnapshot | null>(
      () => cliConversationController?.getSnapshot() ?? null,
    )
  // A CLI run outlives the view that started it, so the controller must know
  // which conversation presents it before background monitoring can locate it.
  useEffect(() => {
    if (!cliConversationController || !cliConversationId) return
    cliConversationController.bindConversation(cliConversationId)
  }, [cliConversationController, cliConversationId])
  useEffect(() => {
    if (!cliConversationController) {
      setCliConversationSnapshot(null)
      return
    }
    const publishSnapshot = () =>
      setCliConversationSnapshot(cliConversationController.getSnapshot())
    publishSnapshot()
    return cliConversationController.subscribe(publishSnapshot)
  }, [cliConversationController])
  const activeCliConversationSnapshot = resolveActiveCliConversationSnapshot(
    activeRuntimeId,
    cliConversationSnapshot,
  )
  const isCliRunActive = isCliConversationActive(activeCliConversationSnapshot)
  const cliOperationCoordinator = useMemo(
    () =>
      cliConversationController
        ? getCliChatOperationCoordinator(cliConversationController)
        : null,
    [cliConversationController],
  )
  const [cliOperationSnapshot, setCliOperationSnapshot] =
    useState<CliChatOperationSnapshot | null>(
      () => cliOperationCoordinator?.getSnapshot() ?? null,
    )
  useEffect(() => {
    if (!cliOperationCoordinator) {
      setCliOperationSnapshot(null)
      return
    }
    const publishSnapshot = () =>
      setCliOperationSnapshot(cliOperationCoordinator.getSnapshot())
    publishSnapshot()
    const unsubscribe = cliOperationCoordinator.subscribe(publishSnapshot)
    return () => {
      unsubscribe()
    }
  }, [cliOperationCoordinator])
  const cliSubmissionPending =
    cliOperationSnapshot?.submissionPhase === 'preparing' ||
    cliOperationSnapshot?.submissionPhase === 'sending'
  const cliTransitioning = cliOperationSnapshot?.isTransitioning === true
  const [cliModelCatalog, setCliModelCatalog] = useState<
    ReadonlyMap<CliRuntimeId, readonly CliRuntimeModel[]>
  >(() => cliRuntimeScope?.getModelCatalogSnapshot() ?? new Map())
  useEffect(() => {
    if (!cliRuntimeScope) return
    const publishCatalog = () =>
      setCliModelCatalog(new Map(cliRuntimeScope.getModelCatalogSnapshot()))
    publishCatalog()
    return cliRuntimeScope.subscribeToModelCatalog(publishCatalog)
  }, [cliRuntimeScope])
  const [cliSkillEntries, setCliSkillEntries] = useState<LiteSkillEntry[]>([])
  // Bumped by `refreshCliSkills` (e.g. after the Claude plugin manager
  // installs/enables/disables a plugin) to force the skills effect below to
  // re-run against the same controller without duplicating its fetch logic.
  const [cliSkillsRefreshTick, setCliSkillsRefreshTick] = useState(0)
  const refreshCliSkills = useCallback(() => {
    setCliSkillsRefreshTick((tick) => tick + 1)
  }, [])
  useEffect(() => {
    if (
      !isCliRuntime(activeRuntimeId) ||
      !RUNTIME_CAPABILITIES[activeRuntimeId].hasNativeSkills ||
      !cliRuntimeScope ||
      !cliConversationController
    ) {
      setCliSkillEntries([])
      return
    }
    let cancelled = false
    void (async () => {
      await prepareCliConversation({
        controller: cliConversationController,
        scope: cliRuntimeScope,
        runtimeId: activeRuntimeId,
        settings: cliPreferenceSettingsRef.current,
        permissionProfile: cliPermissionProfileRef.current,
      })
      const skills = await cliConversationController.listSkills()
      if (cancelled) return
      setCliSkillEntries(
        skills.map((skill) => ({
          ...skill,
          mode: 'lazy',
          isReadOnly: true,
        })),
      )
    })().catch((error) => {
      if (cancelled) return
      console.warn('[YOLO] Failed to load native CLI skills', error)
      setCliSkillEntries([])
    })
    return () => {
      cancelled = true
    }
  }, [
    activeRuntimeId,
    cliConversationController,
    cliRuntimeScope,
    cliSkillsRefreshTick,
  ])
  useEffect(() => {
    if (activeRuntimeId === 'yolo' || !cliConversationController) return
    const snapshot = cliConversationController.getSnapshot()
    // After reload, hydrate may bind sessionRef before the model catalog is
    // warm enough for stageConfiguration. Keep retrying until configuration
    // exists so the model/reasoning controls are not stuck disabled.
    if (!snapshot.configuration) {
      cliConversationController.stageConfiguration(
        resolveCliRuntimePreference(
          cliPreferenceSettingsRef.current,
          activeRuntimeId,
          cliModelCatalog.get(activeRuntimeId) ?? [],
        ),
      )
    }
    // Nothing requested and nothing remembered: ask the runtime itself which
    // model will actually run (pi answers via get_state before any session
    // exists; the shared warm-up instance caches it, so this is a memory read
    // after the catalog warm). Session-scoped runtimes (ACP) simply report
    // no selection here and the picker fills in on bind instead.
    const staged = cliConversationController.getSnapshot().configuration
    if (staged?.modelId != null || snapshot.sessionRef || !cliRuntimeScope) {
      return
    }
    let cancelled = false
    void cliRuntimeScope
      .resolveRuntime(activeRuntimeId)
      .getConfiguration(cliModelCatalog.get(activeRuntimeId) ?? [])
      .then((configuration) => {
        if (cancelled || !configuration.modelId) return
        const current = cliConversationController.getSnapshot()
        if (current.configuration?.modelId != null) return
        cliConversationController.stageConfiguration({
          modelId: configuration.modelId,
          ...(configuration.reasoningEffort
            ? { reasoningEffort: configuration.reasoningEffort }
            : {}),
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [
    activeRuntimeId,
    cliConversationController,
    cliRuntimeScope,
    cliModelCatalog,
    settings.chatOptions.cliModelIdByRuntime,
    settings.chatOptions.cliReasoningEffortByModel,
  ])
  useEffect(() => {
    if (!cliRuntimeScope || activeRuntimeId === 'yolo') return
    void cliRuntimeScope
      .warmModelCatalog(activeRuntimeId)
      .catch(() => undefined)
  }, [activeRuntimeId, cliRuntimeScope])

  const activeHistoryConversationId =
    activeRuntimeId === 'yolo'
      ? currentConversationId
      : (cliConversationId ?? currentConversationId)

  useEffect(() => {
    if (
      !cliRuntimeScope ||
      !isCliRuntime(activeRuntimeId) ||
      !RUNTIME_CAPABILITIES[activeRuntimeId].needsWarmup
    )
      return
    void cliRuntimeScope
      .warmConversationRuntime(activeRuntimeId)
      .catch(() => undefined)
  }, [activeRuntimeId, cliRuntimeScope])

  const cliSessionRestoreGenerationRef = useRef(0)
  useEffect(() => {
    const seededRef = seededCliSessionRef
    if (
      !seededRef ||
      activeRuntimeId === 'yolo' ||
      !cliRuntimeScope ||
      !cliConversationController ||
      !cliOperationCoordinator
    ) {
      return
    }
    const controllerSnapshot = cliConversationController.getSnapshot()
    // A surviving scope/controller is authoritative on ordinary rebuilds.
    // Only a fresh, unbound controller needs one native hydration from seed.
    if (!shouldHydrateSeededCliSession(seededRef, controllerSnapshot)) return

    const generation = ++cliSessionRestoreGenerationRef.current
    void cliOperationCoordinator
      .transition(cliConversationController, async (isCurrent) => {
        const isCurrentRestore = () =>
          isCurrent() &&
          generation === cliSessionRestoreGenerationRef.current &&
          chatMountedRef.current
        const result = await openCliSession({
          scope: cliRuntimeScope,
          ref: seededRef,
          isCurrent: isCurrentRestore,
        })
        if (!result.hydration || !isCurrentRestore()) {
          return
        }
        await prepareCliConversation({
          controller: result.controller,
          scope: cliRuntimeScope,
          runtimeId: seededRef.runtimeId,
          settings,
          permissionProfile: cliPermissionProfileRef.current,
        })
        if (!isCurrentRestore()) return
        const restoredConversationId = seededCliConversationId ?? uuidv4()
        setCliConversationController(result.controller)
        setCliConversationId(restoredConversationId)
        lastCliRuntimeIdRef.current = seededRef.runtimeId
        setRequestedRuntimeId(seededRef.runtimeId)
        activeRuntimeIdRef.current = seededRef.runtimeId
        // A resumed session's own ref is authoritative on which Hermes
        // profile it lives under — unless a fallback occurred, in the
        // `openSession()` peek above or in `prepareCliConversation()`'s own
        // `ensureReady()` load, because the requested profile no longer
        // resolves (see `AcpCliRuntimeOptions.sessionRecovery`). Either way
        // the *fallback* session is what's actually live and must be
        // reflected in both the header and conversation storage, not the
        // now-dead requested profile — so this reads the controller's
        // settled snapshot, not just the first load's hydration, to catch a
        // fallback from either load (see `resolveHermesSessionFallbackUpdate`).
        const fallbackUpdate = resolveHermesSessionFallbackUpdate(
          seededRef.runtimeId,
          result.controller.getSnapshot(),
        )
        setHermesProfileId(
          fallbackUpdate
            ? fallbackUpdate.hermesProfileId
            : seededRef.runtimeId === 'hermes'
              ? seededRef.profileId
              : undefined,
        )
        if (fallbackUpdate) {
          void createOrTouchCliConversation(
            restoredConversationId,
            fallbackUpdate.cliSession,
            conversationOverridesRef.current.get(restoredConversationId) ??
              conversationOverrides,
          ).catch((error: unknown) => {
            console.error(
              '[YOLO] Failed to persist Hermes fallback session',
              error,
            )
          })
        }
        if (result.overlayError) {
          console.warn('[YOLO] Failed to restore CLI conversation metadata', {
            conversationId: seededCliConversationId,
            error: result.overlayError.message,
          })
        }
      })
      .catch((error) => {
        if (
          generation !== cliSessionRestoreGenerationRef.current ||
          !chatMountedRef.current
        ) {
          return
        }
        new Notice(
          t(
            'chat.cliSurface.openError',
            'Could not open the CLI session: {message}',
          ).replace(
            '{message}',
            error instanceof Error ? error.message : String(error),
          ),
        )
      })
    return () => {
      cliSessionRestoreGenerationRef.current += 1
    }
  }, [
    activeRuntimeId,
    activeRuntimeIdRef,
    chatMountedRef,
    cliConversationController,
    cliOperationCoordinator,
    cliRuntimeScope,
    conversationOverrides,
    createOrTouchCliConversation,
    seededCliConversationId,
    seededCliSessionRef,
    settings,
    t,
  ])

  const transitionCliSession = useCallback(
    async (
      action: (isCurrent: () => boolean) => void | Promise<void>,
    ): Promise<boolean> => {
      if (!cliConversationController || !cliOperationCoordinator) return false
      try {
        return await cliOperationCoordinator.transition(
          cliConversationController,
          action,
        )
      } catch (error) {
        new Notice(
          t(
            'chat.cliSurface.transitionError',
            'Could not leave the current CLI session: {message}',
          ).replace(
            '{message}',
            error instanceof Error ? error.message : String(error),
          ),
        )
        return false
      }
    },
    [cliConversationController, cliOperationCoordinator, t],
  )

  const createFreshCliConversation = useCallback(
    (
      runtimeId: CliRuntimeId,
      profileId?: string,
    ): CliConversationController | null => {
      if (!cliRuntimeScope) return null
      conversationOverridesRef.current.set(
        activeHistoryConversationId,
        conversationOverrides,
      )
      const previousConfiguration =
        cliConversationController?.getSnapshot().runtimeId === runtimeId
          ? cliConversationController.getSnapshot().configuration
          : null
      const controller = cliRuntimeScope.createConversationRuntime(
        runtimeId,
        profileId,
      )
      if (runtimeId === 'hermes') {
        if (profileId) registerCliConversationProfileId(controller, profileId)
        setHermesProfileId(profileId)
      }
      const preference = previousConfiguration
        ? {
            modelId: previousConfiguration.modelId,
            reasoningEffort: previousConfiguration.reasoningEffort,
          }
        : resolveCliRuntimePreference(
            cliPreferenceSettingsRef.current,
            runtimeId,
            cliModelCatalog.get(runtimeId) ?? [],
          )
      controller.stageConfiguration(preference)
      if (previousConfiguration) {
        cliPreferenceSettingsRef.current = rememberCliRuntimeConfiguration(
          cliPreferenceSettingsRef.current,
          runtimeId,
          previousConfiguration,
        )
        void updateSettings((current) =>
          rememberCliRuntimeConfiguration(
            current,
            runtimeId,
            previousConfiguration,
          ),
        )
      }
      const nextCliConversationId = uuidv4()
      setCliConversationController(controller)
      setCliConversationId(nextCliConversationId)
      setConversationOverrides(null)
      conversationOverridesRef.current.set(nextCliConversationId, null)
      return controller
    },
    [
      activeHistoryConversationId,
      cliConversationController,
      cliModelCatalog,
      cliRuntimeScope,
      conversationOverrides,
      updateSettings,
    ],
  )

  /**
   * Hermes profile switch from the header selector. Design (not a fallback
   * heuristic — see the feature's spec): an empty conversation (no messages
   * yet) swaps its runtime/controller in place and keeps presenting as the
   * same on-screen conversation, since nothing has been persisted for it
   * yet; a conversation that already has messages instead starts a brand
   * new one under the chosen profile — profiles are separate Hermes
   * memories (separate `HERMES_HOME` directories/session databases), so
   * there is no in-place history migration to perform.
   */
  const switchHermesProfile = useCallback(
    (profileId: string | undefined) => {
      if (!cliRuntimeScope) return
      const action = resolveHermesProfileSwitchAction({
        activeRuntimeId,
        requestedProfileId: profileId,
        currentProfileId: hermesProfileId,
        hasMessages:
          (cliConversationController?.getSnapshot().messages.length ?? 0) > 0,
      })
      if (action === 'noop') return
      if (action === 'new-conversation') {
        void transitionCliSession((isCurrent) => {
          if (!isCurrent()) return
          createFreshCliConversation('hermes', profileId)
        })
        return
      }
      void transitionCliSession((isCurrent) => {
        if (!isCurrent()) return
        const previousConfiguration =
          cliConversationController?.getSnapshot().runtimeId === 'hermes'
            ? cliConversationController.getSnapshot().configuration
            : null
        const controller = cliRuntimeScope.createConversationRuntime(
          'hermes',
          profileId,
        )
        if (profileId) registerCliConversationProfileId(controller, profileId)
        const preference = previousConfiguration
          ? {
              modelId: previousConfiguration.modelId,
              reasoningEffort: previousConfiguration.reasoningEffort,
            }
          : resolveCliRuntimePreference(
              cliPreferenceSettingsRef.current,
              'hermes',
              cliModelCatalog.get('hermes') ?? [],
            )
        controller.stageConfiguration(preference)
        setCliConversationController(controller)
        setHermesProfileId(profileId)
      })
    },
    [
      activeRuntimeId,
      cliConversationController,
      cliModelCatalog,
      cliRuntimeScope,
      createFreshCliConversation,
      hermesProfileId,
      transitionCliSession,
    ],
  )

  const consumeAcceptedCliDraft = useCallback(
    (acceptedDraft: NonNullable<CliChatOperationSnapshot['acceptedDraft']>) => {
      if (
        !cliOperationCoordinator ||
        cliOperationCoordinator.getSnapshot().acceptedDraft?.token !==
          acceptedDraft.token
      ) {
        return
      }
      cliOperationCoordinator.acknowledgeAcceptedDraft(acceptedDraft.token)
    },
    [cliOperationCoordinator],
  )
  const consumePresentedCliDraft = useCallback(
    (
      presentedDraft: NonNullable<CliChatOperationSnapshot['presentedDraft']>,
    ) => {
      if (
        !cliOperationCoordinator ||
        cliOperationCoordinator.getSnapshot().presentedDraft?.token !==
          presentedDraft.token
      ) {
        return
      }
      cliOperationCoordinator.acknowledgePresentedDraft(presentedDraft.token)
      commitSentSelectionHighlights(presentedDraft.userMessage.mentionables)
      const latestDraft = getLatestInputMessage()
      if (
        shouldClearAcceptedCliDraft({
          acceptedDraft: presentedDraft,
          currentDraft: latestDraft,
          currentDraftRevision: inputDraftRevisionRef.current,
        })
      ) {
        replaceInputMessage(buildNewInputMessage(reasoningLevel))
      }
    },
    [
      buildNewInputMessage,
      cliOperationCoordinator,
      commitSentSelectionHighlights,
      getLatestInputMessage,
      inputDraftRevisionRef,
      reasoningLevel,
      replaceInputMessage,
    ],
  )
  useEffect(() => {
    const acceptedDraft = cliOperationSnapshot?.acceptedDraft
    if (acceptedDraft) consumeAcceptedCliDraft(acceptedDraft)
  }, [cliOperationSnapshot?.acceptedDraft, consumeAcceptedCliDraft])

  const applyCliModePreference = useCallback(
    async (
      runtimeId: CliRuntimeId,
      preference: { mode: CliChatMode; yoloEnabled: boolean },
      options?: { rememberPrePlan?: boolean },
    ): Promise<void> => {
      const mode = normalizeCliModeForRuntime(runtimeId, preference.mode)
      const yoloEnabled = mode === 'plan' ? false : preference.yoloEnabled
      const generation = ++cliModeRequestGenerationRef.current
      const controller =
        cliConversationController?.getSnapshot().runtimeId === runtimeId
          ? cliConversationController
          : null
      try {
        if (controller) {
          await controller.updatePermissionProfile({
            mode,
            yoloEnabled,
          })
        }
      } catch (error) {
        if (generation !== cliModeRequestGenerationRef.current) return
        new Notice(
          t(
            'chat.cliControls.updateError',
            '无法更新 CLI 配置：{message}',
          ).replace(
            '{message}',
            error instanceof Error ? error.message : String(error),
          ),
        )
        return
      }
      if (generation !== cliModeRequestGenerationRef.current) return

      const preferenceConversationId =
        activeRuntimeId === 'yolo'
          ? currentConversationId
          : (cliConversationId ?? activeHistoryConversationId)
      if (
        options?.rememberPrePlan &&
        mode === 'plan' &&
        cliChatMode !== 'plan'
      ) {
        rememberPrePlanCliMode(
          prePlanCliModeByConversationRef,
          preferenceConversationId,
          cliYoloEnabled,
        )
      }
      prunePrePlanCliMode(
        prePlanCliModeByConversationRef,
        preferenceConversationId,
        runtimeId,
        mode,
      )
      setCliChatMode(mode)
      setCliYoloEnabled(yoloEnabled)
      const nextOverrides = patchConversationCliModeOverrides(
        conversationOverridesRef.current.get(preferenceConversationId) ??
          conversationOverrides,
        runtimeId,
        { mode, yoloEnabled },
      )
      setConversationOverrides(nextOverrides)
      conversationOverridesRef.current.set(
        preferenceConversationId,
        nextOverrides,
      )
      void updateSettings((current) =>
        rememberCliModePreference(current, runtimeId, {
          mode,
          yoloEnabled,
        }),
      ).catch((error: unknown) => {
        console.error('Failed to persist CLI mode preference', error)
      })
      const sessionRef = controller?.getSnapshot().sessionRef
      if (sessionRef && controller && isCliRuntime(activeRuntimeId)) {
        void createOrTouchCliConversation(
          preferenceConversationId,
          resolveCliSessionRefProfileId(controller, sessionRef),
          nextOverrides,
        ).catch((error: unknown) => {
          console.error('Failed to persist CLI conversation preference', error)
        })
      }
    },
    [
      activeHistoryConversationId,
      activeRuntimeId,
      cliChatMode,
      cliConversationController,
      cliConversationId,
      cliYoloEnabled,
      conversationOverrides,
      createOrTouchCliConversation,
      currentConversationId,
      t,
      updateSettings,
    ],
  )

  const restoreClaudeAgentMode = useCallback(() => {
    void applyCliModePreference(
      'claude-code',
      readPrePlanCliMode(
        prePlanCliModeByConversationRef,
        activeHistoryConversationId,
      ),
    )
  }, [activeHistoryConversationId, applyCliModePreference])

  const handleCliModeSelectChange = useCallback(
    (nextMode: ChatModeSelectValue) => {
      if (!isCliRuntime(activeRuntimeId)) return
      if (nextMode === 'ask') return
      // CLI runtimes never offer a module chat mode (`CLAUDE_CODE_CHAT_MODES`
      // / `CODEX_CHAT_MODES` are fixed 'agent'/'plan' lists) — this is an
      // unreachable defensive guard, needed only to narrow `ChatModeSelectValue`
      // (which structurally includes module ids) down to `CliChatMode`.
      if (isModuleChatMode(nextMode)) return
      if (
        activeRuntimeId === 'claude-code' &&
        cliChatMode === 'plan' &&
        nextMode === 'agent'
      ) {
        restoreClaudeAgentMode()
        return
      }
      void applyCliModePreference(
        activeRuntimeId,
        {
          mode: nextMode,
          yoloEnabled: nextMode === 'plan' ? false : cliYoloEnabled,
        },
        { rememberPrePlan: nextMode === 'plan' },
      )
    },
    [
      activeRuntimeId,
      applyCliModePreference,
      cliChatMode,
      cliYoloEnabled,
      restoreClaudeAgentMode,
    ],
  )

  const handleCliYoloChange = useCallback(
    (enabled: boolean) => {
      if (!isCliRuntime(activeRuntimeId) || cliChatMode === 'plan') return
      if (enabled && !settings.chatOptions.fullAccessWarningConfirmed) {
        new AcknowledgementModal(app, {
          title: t(
            'chatMode.fullAccessWarning.title',
            'Please confirm before enabling YOLO Mode',
          ),
          messages: [
            t(
              'chatMode.fullAccessWarning.description',
              'YOLO Mode auto-approves all tool calls, including file edits and terminal commands. Review the risks before continuing:',
            ),
          ],
          items: [
            t(
              'chatMode.fullAccessWarning.permission',
              'Tools run without per-call approval. Dangerous command prefixes are still blocked.',
            ),
            t(
              'chatMode.fullAccessWarning.cost',
              'Autonomous runs may consume significant model resources and incur higher costs.',
            ),
            t(
              'chatMode.fullAccessWarning.backup',
              'Back up important content in advance to avoid unintended changes.',
            ),
          ],
          checkboxLabel: t(
            'chatMode.fullAccessWarning.checkbox',
            'I understand the risks above and accept responsibility for proceeding',
          ),
          cancelText: t('chatMode.fullAccessWarning.cancel', 'Cancel'),
          confirmText: t(
            'chatMode.fullAccessWarning.confirm',
            'Continue with YOLO Mode',
          ),
          confirmTone: 'warning',
          onConfirm: () => {
            void applyCliModePreference(activeRuntimeId, {
              mode: 'agent',
              yoloEnabled: true,
            })
            void updateSettings((current) => ({
              ...current,
              chatOptions: {
                ...current.chatOptions,
                fullAccessWarningConfirmed: true,
              },
            })).catch((error: unknown) => {
              console.error(
                'Failed to persist YOLO warning confirmation',
                error,
              )
            })
          },
        }).open()
        return
      }
      void applyCliModePreference(activeRuntimeId, {
        mode: cliChatMode,
        yoloEnabled: enabled,
      })
    },
    [
      activeRuntimeId,
      app,
      applyCliModePreference,
      cliChatMode,
      settings.chatOptions.fullAccessWarningConfirmed,
      t,
      updateSettings,
    ],
  )

  const handleClaudePlanShortcut = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (!RUNTIME_CAPABILITIES[activeRuntimeId].supportsPlanMode) return
      if (
        event.key !== 'Tab' ||
        !event.shiftKey ||
        event.nativeEvent.isComposing
      ) {
        return
      }
      event.preventDefault()
      if (cliChatMode === 'plan') {
        restoreClaudeAgentMode()
        return
      }
      void applyCliModePreference(
        'claude-code',
        { mode: 'plan', yoloEnabled: false },
        { rememberPrePlan: true },
      )
    },
    [
      activeRuntimeId,
      applyCliModePreference,
      cliChatMode,
      restoreClaudeAgentMode,
    ],
  )

  useEffect(() => {
    if (!isCliRuntime(activeRuntimeId) || !cliConversationController) return
    void cliConversationController
      .updatePermissionProfile({
        mode: cliChatMode,
        yoloEnabled: cliChatMode === 'plan' ? false : cliYoloEnabled,
      })
      .catch((error) => {
        new Notice(
          t(
            'chat.cliControls.updateError',
            '无法更新 CLI 配置：{message}',
          ).replace(
            '{message}',
            error instanceof Error ? error.message : String(error),
          ),
        )
      })
  }, [
    activeRuntimeId,
    cliChatMode,
    cliConversationController,
    cliYoloEnabled,
    t,
  ])

  const cliChatRuntimeActions = useMemo((): ChatRuntimeActions | null => {
    if (!cliRuntimeScope) return null
    const base = cliRuntimeScope.chatRuntimeActions
    return {
      ...base,
      approveTool: async (action: ChatRuntimeApprovalAction) => {
        const result = await base.approveTool(action)
        if (
          result.kind === 'handled' &&
          RUNTIME_CAPABILITIES[activeRuntimeId].supportsPlanMode &&
          cliChatMode === 'plan'
        ) {
          const messages =
            cliConversationController?.getSnapshot().messages ?? []
          const approvedExitPlan = messages.some(
            (message) =>
              message.role === 'tool' &&
              message.toolCalls?.some(
                (toolCall) =>
                  toolCall.request.id === action.toolCallId &&
                  toolCall.request.name === CLAUDE_EXIT_PLAN_MODE_TOOL,
              ),
          )
          if (approvedExitPlan) {
            restoreClaudeAgentMode()
          }
        }
        return result
      },
    }
  }, [
    activeRuntimeId,
    applyCliModePreference,
    cliChatMode,
    cliConversationController,
    cliRuntimeScope,
    restoreClaudeAgentMode,
  ])

  const persistCliConfiguration = useCallback(
    (configuration: CliRuntimeConfiguration) => {
      if (!cliConversationController || !isCliRuntime(activeRuntimeId)) return
      const ref = cliConversationController.getSnapshot().sessionRef
      if (ref && cliRuntimeScope) {
        void cliRuntimeScope.sessionService.rememberConfiguration(ref, {
          modelId: configuration.modelId,
          reasoningEffort: configuration.reasoningEffort,
        })
      }
      cliPreferenceSettingsRef.current = rememberCliRuntimeConfiguration(
        cliPreferenceSettingsRef.current,
        activeRuntimeId,
        configuration,
      )
      void updateSettings((current) =>
        rememberCliRuntimeConfiguration(
          current,
          activeRuntimeId,
          configuration,
        ),
      )
    },
    [
      activeRuntimeId,
      cliConversationController,
      cliRuntimeScope,
      updateSettings,
    ],
  )

  // Runtimes that restore their real current model on bind (pi via
  // get_state, Hermes via ACP's currentModelId) are the source of truth for
  // "which model will actually run". Remember that restored model so the next
  // fresh conversation's staged (pre-bind) picker shows it instead of an
  // empty selection — staging deliberately never invents a pick on its own.
  useEffect(() => {
    if (!isCliRuntime(activeRuntimeId)) return
    const configuration = activeCliConversationSnapshot?.configuration
    if (!configuration?.modelId || !activeCliConversationSnapshot?.sessionRef) {
      return
    }
    const remembered =
      cliPreferenceSettingsRef.current.chatOptions.cliModelIdByRuntime?.[
        activeRuntimeId
      ]
    if (remembered === configuration.modelId) return
    persistCliConfiguration(configuration)
  }, [activeRuntimeId, activeCliConversationSnapshot, persistCliConfiguration])

  const handleCliModelChange = useCallback(
    (modelId: string | null) => {
      if (!cliConversationController || !isCliRuntime(activeRuntimeId)) return
      const rememberedEffort = modelId
        ? cliPreferenceSettingsRef.current.chatOptions
            .cliReasoningEffortByModel?.[`${activeRuntimeId}:${modelId}`]
        : undefined
      void cliConversationController
        .updateConfiguration({
          modelId,
          reasoningEffort: rememberedEffort ?? null,
        })
        .then((configuration) => {
          if (!configuration) return
          persistCliConfiguration(configuration)
        })
        .catch((error) => {
          new Notice(
            t(
              'chat.cliControls.updateError',
              '无法更新 CLI 配置：{message}',
            ).replace(
              '{message}',
              error instanceof Error ? error.message : String(error),
            ),
          )
        })
    },
    [activeRuntimeId, cliConversationController, persistCliConfiguration, t],
  )

  const handleCliReasoningEffortChange = useCallback(
    (reasoningEffort: string | null) => {
      if (!cliConversationController || !isCliRuntime(activeRuntimeId)) return
      void cliConversationController
        .updateConfiguration({ reasoningEffort })
        .then((configuration) => {
          if (!configuration) return
          persistCliConfiguration(configuration)
        })
        .catch((error) => {
          new Notice(
            t(
              'chat.cliControls.updateError',
              '无法更新 CLI 配置：{message}',
            ).replace(
              '{message}',
              error instanceof Error ? error.message : String(error),
            ),
          )
        })
    },
    [activeRuntimeId, cliConversationController, persistCliConfiguration, t],
  )

  const handleCliUserMessageRewrite = useCallback(
    async (
      sourceMessage: ChatUserMessage,
      editedMessage: ChatUserMessage,
      turnConfiguration?: CliTurnConfiguration,
    ) => {
      if (
        !isCliRuntime(activeRuntimeId) ||
        !RUNTIME_CAPABILITIES[activeRuntimeId].supportsMessageRewrite ||
        !cliConversationController ||
        !cliOperationCoordinator ||
        !cliRuntimeScope ||
        !cliConversationId
      ) {
        throw new Error('CLI conversation is not ready for editing.')
      }
      try {
        let rewriteResult: Awaited<
          ReturnType<typeof rewriteCliConversationTurn>
        > | null = null
        const completed = await cliOperationCoordinator.transition(
          cliConversationController,
          async (isCurrent) => {
            const environmentContext = await buildCliEnvironmentContext({
              app,
              settings,
              currentFile: activeFile,
              currentFileViewState: activeViewState,
            })
            rewriteResult = await rewriteCliConversationTurn({
              settings,
              scope: cliRuntimeScope,
              controller: cliConversationController,
              runtimeId: activeRuntimeId,
              sourceUserMessageId: sourceMessage.id,
              environmentContext,
              permissionProfile: cliPermissionProfileRef.current,
              configuration: turnConfiguration,
              userMessage: {
                ...editedMessage,
                id: sourceMessage.id,
              },
            })
            if (!isCurrent() || !rewriteResult) return
            if (turnConfiguration) {
              const appliedConfiguration =
                cliConversationController.getSnapshot().configuration
              if (appliedConfiguration) {
                persistCliConfiguration(appliedConfiguration)
              }
            }
            await createOrTouchCliConversation(
              cliConversationId,
              {
                runtimeId: rewriteResult.sessionRef.runtimeId,
                nativeSessionId: rewriteResult.sessionRef.nativeSessionId,
                ...(rewriteResult.sessionRef.sessionPathHint
                  ? {
                      sessionPathHint: rewriteResult.sessionRef.sessionPathHint,
                    }
                  : {}),
                ...(rewriteResult.sessionRef.profileId
                  ? { profileId: rewriteResult.sessionRef.profileId }
                  : {}),
              },
              conversationOverridesRef.current.get(cliConversationId) ??
                conversationOverrides,
            )
            if (rewriteResult.overlayError) {
              console.warn('[YOLO] Failed to save rewritten CLI metadata', {
                conversationId: cliConversationId,
                error: rewriteResult.overlayError.message,
              })
            }
          },
        )
        if (!completed) return
      } catch (error) {
        new Notice(
          t(
            'chat.cliSurface.submitError',
            'Could not send the CLI message: {message}',
          ).replace(
            '{message}',
            error instanceof Error ? error.message : String(error),
          ),
        )
        throw error
      }
    },
    [
      activeRuntimeId,
      activeFile,
      activeViewState,
      app,
      cliConversationController,
      cliConversationId,
      cliOperationCoordinator,
      cliRuntimeScope,
      createOrTouchCliConversation,
      conversationOverrides,
      persistCliConfiguration,
      settings,
      t,
    ],
  )

  return {
    cliPreferenceSettingsRef,
    syncCliConversationTitle,

    cliChatMode,
    setCliChatMode,
    cliYoloEnabled,
    setCliYoloEnabled,

    cliConversationController,
    setCliConversationController,
    cliConversationId,
    setCliConversationId,
    activeCliConversationSnapshot,
    isCliRunActive,
    cliOperationCoordinator,
    cliOperationSnapshot,
    cliSubmissionPending,
    cliTransitioning,
    cliModelCatalog,
    cliSkillEntries,
    refreshCliSkills,
    activeHistoryConversationId,

    transitionCliSession,
    createFreshCliConversation,

    hermesProfileId,
    setHermesProfileId,
    switchHermesProfile,

    consumeAcceptedCliDraft,
    consumePresentedCliDraft,

    applyCliModePreference,
    restoreClaudeAgentMode,
    handleCliModeSelectChange,
    handleCliYoloChange,
    handleClaudePlanShortcut,
    cliChatRuntimeActions,

    handleCliModelChange,
    handleCliReasoningEffortChange,
    handleCliUserMessageRewrite,
  }
}
