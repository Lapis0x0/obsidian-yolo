import { App, Notice } from 'obsidian'
import {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { v4 as uuidv4 } from 'uuid'

import { resolveAssistantModelId } from '../../core/agent/assistant-model'
import { DEFAULT_ASSISTANT_ID } from '../../core/agent/default-assistant'
import {
  type ChatRuntimeId,
  type CliChatMode,
  type CliConversationController,
  type CliRuntimeId,
  type CliRuntimeModel,
  type CliRuntimeScope,
} from '../../core/cli-runtime'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { Assistant } from '../../types/assistant.types'
import type { ChatUserMessage } from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type { ReasoningLevel } from '../../types/reasoning'
import { AcknowledgementModal } from '../modals/AcknowledgementModal'

import { type ChatMode, isAgentChatMode } from './chat-input/ChatModeSelect'
import {
  beginChatRuntimeNavigation,
  resolveChatRuntimeId,
} from './cliChatIntegration'
import {
  type CliModePreference,
  resolveCliModePreference,
  resolveCliRuntimePreference,
} from './cliRuntimePreferences'

function useLatestRef<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/**
 * useCliRuntimeOrchestration 与 useChatStreamManager 之后才产生的依赖——
 * handleRuntimeChange 反过来消费它们。与 useChatInputController 的
 * lateStateRef 惯例完全一致：Chat.tsx 在 CLI 编排 hook 就绪之后写入
 * 最新快照，本 hook 内的处理器一律经 getLate() 读取。
 */
export type ChatRuntimePreferencesLateState = {
  setInputMessage: Dispatch<SetStateAction<ChatUserMessage>>
  conversationModelId: string
  setConversationModelId: Dispatch<SetStateAction<string>>
  setReasoningLevel: Dispatch<SetStateAction<ReasoningLevel>>
  setChatMode: Dispatch<SetStateAction<ChatMode>>
  setYoloEnabled: Dispatch<SetStateAction<boolean>>
  conversationOverrides: ConversationOverrideSettings | null
  setConversationOverrides: Dispatch<
    SetStateAction<ConversationOverrideSettings | null>
  >
  selectedAssistant: Assistant | null
  getReasoningLevelForModelId: (modelId?: string | null) => ReasoningLevel
  cliPreferenceSettingsRef: MutableRefObject<YoloSettings>
  cliModelCatalog: ReadonlyMap<CliRuntimeId, readonly CliRuntimeModel[]>
  setCliConversationController: Dispatch<
    SetStateAction<CliConversationController | null>
  >
  setCliConversationId: Dispatch<SetStateAction<string | null>>
  setCliChatMode: Dispatch<SetStateAction<CliChatMode>>
  setCliYoloEnabled: Dispatch<SetStateAction<boolean>>
  transitionCliSession: (
    action: (isCurrent: () => boolean) => void | Promise<void>,
  ) => Promise<boolean>
  activeHistoryConversationId: string
}

export type UseChatRuntimePreferencesParams = {
  app: App
  t: (keyPath: string, fallback?: string) => string
  settings: YoloSettings
  setSettings: (settings: YoloSettings) => Promise<boolean>
  cliRuntimeScope: CliRuntimeScope | undefined
  cliRuntimeAvailable: boolean
  chatMountedRef: MutableRefObject<boolean>

  // 运行时切换初始值：仅首次渲染读取
  seededActiveRuntimeId: ChatRuntimeId | undefined
  seededConversationOverrides: ConversationOverrideSettings | null | undefined
  hasInitialConversationId: boolean

  // 会话身份——由 Chat.tsx 持有，本 hook 调用时已可用
  currentConversationId: string

  // 每会话 assistant 偏好——raw state 仍declared 在 Chat.tsx
  conversationAssistantId: string
  setConversationAssistantId: Dispatch<SetStateAction<string>>
}

/**
 * 运行时切换（requestedRuntimeId/handleRuntimeChange）+ 每会话偏好持久化
 * （model/reasoning/assistant/mode/yolo 的 Map 缓存与 persist* 全族）。
 *
 * 本 hook 必须在 useChatInputController 之前调用——后者的
 * UseChatInputControllerParams.activeRuntimeId 直接消费本 hook 的输出。
 * 但 handleRuntimeChange 等处理器反过来需要 useCliRuntimeOrchestration /
 * 输入控制器 / 会话状态在本 hook 调用之后才产生的值，因此这些处理器一律
 * 经 `lateStateRef` 读取——Chat.tsx 在 CLI 编排 hook 就绪之后写入最新
 * 快照，写入时机与既有 `inputController.lateStateRef` 完全一致。
 */
export function useChatRuntimePreferences({
  app,
  t,
  settings,
  setSettings,
  cliRuntimeScope,
  cliRuntimeAvailable,
  chatMountedRef,
  seededActiveRuntimeId,
  seededConversationOverrides,
  hasInitialConversationId,
  currentConversationId,
  conversationAssistantId,
  setConversationAssistantId,
}: UseChatRuntimePreferencesParams) {
  const preferredCliRuntimeId =
    settings.chatOptions.lastCliRuntimeId ?? 'claude-code'
  const preferredRuntimeId: ChatRuntimeId =
    settings.chatOptions.lastChatSurface === 'cli'
      ? preferredCliRuntimeId
      : 'yolo'
  const initialActiveRuntimeId = resolveChatRuntimeId({
    requestedRuntimeId:
      seededActiveRuntimeId ??
      (hasInitialConversationId ? 'yolo' : preferredRuntimeId),
    hasCliRuntimeScope: cliRuntimeScope !== undefined,
    cliRuntimeAvailable,
  })
  const [requestedRuntimeId, setRequestedRuntimeId] = useState<ChatRuntimeId>(
    initialActiveRuntimeId,
  )
  const activeRuntimeId = resolveChatRuntimeId({
    requestedRuntimeId,
    hasCliRuntimeScope: cliRuntimeScope !== undefined,
    cliRuntimeAvailable,
  })
  const activeRuntimeIdRef = useLatestRef(activeRuntimeId)
  const lastCliRuntimeIdRef = useRef<CliRuntimeId>(
    initialActiveRuntimeId === 'yolo'
      ? preferredCliRuntimeId
      : initialActiveRuntimeId,
  )
  const initialCliModePreference: CliModePreference = resolveCliModePreference(
    settings,
    initialActiveRuntimeId === 'yolo'
      ? preferredCliRuntimeId
      : initialActiveRuntimeId,
    seededConversationOverrides ?? null,
  )
  const prePlanCliModeByConversationRef = useRef(
    new Map<string, { mode: 'agent'; yoloEnabled: boolean }>(),
  )
  const cliModeRequestGenerationRef = useRef(0)
  const runtimeNavigationGenerationRef = useRef(0)

  // 每会话偏好缓存：切换会话/运行时时用于恢复上次使用的 model/reasoning/
  // assistant/mode+yolo。mode 与 yolo 合并存放在 conversationOverridesRef
  // 中（与 conversationOverrides 状态的形状一致）。
  const conversationModelIdRef = useRef<Map<string, string>>(new Map())
  const conversationReasoningLevelRef = useRef<Map<string, ReasoningLevel>>(
    new Map(),
  )
  const conversationAssistantIdRef = useRef<Map<string, string>>(new Map())
  const conversationOverridesRef = useRef<
    Map<string, ConversationOverrideSettings | null>
  >(new Map())

  useEffect(() => {
    if (
      settings.assistants.some(
        (assistant) => assistant.id === conversationAssistantId,
      )
    ) {
      return
    }
    const fallbackAssistantId =
      settings.currentAssistantId ??
      settings.assistants[0]?.id ??
      DEFAULT_ASSISTANT_ID
    setConversationAssistantId(fallbackAssistantId)
    conversationAssistantIdRef.current.set(
      currentConversationId,
      fallbackAssistantId,
    )
  }, [
    conversationAssistantId,
    currentConversationId,
    settings.assistants,
    settings.currentAssistantId,
    setConversationAssistantId,
  ])

  const persistReasoningLevelForModel = useCallback(
    async (modelId: string, level: ReasoningLevel) => {
      if (!modelId) return
      const currentMap = settings.chatOptions.reasoningLevelByModelId ?? {}
      if (currentMap[modelId] === level) return
      try {
        await setSettings({
          ...settings,
          chatOptions: {
            ...settings.chatOptions,
            reasoningLevelByModelId: {
              ...currentMap,
              [modelId]: level,
            },
          },
        })
      } catch (error: unknown) {
        console.error('Failed to persist reasoning level preference', error)
      }
    },
    [setSettings, settings],
  )

  const persistPreferredChatMode = useCallback(
    async (mode: ChatMode) => {
      if (settings.chatOptions.chatMode === mode) {
        return
      }

      try {
        await setSettings({
          ...settings,
          chatOptions: {
            ...settings.chatOptions,
            chatMode: mode,
          },
        })
      } catch (error: unknown) {
        console.error('Failed to persist preferred chat mode', error)
      }
    },
    [setSettings, settings],
  )

  const persistPreferredYolo = useCallback(
    async (enabled: boolean) => {
      if ((settings.chatOptions.agentYoloEnabled ?? false) === enabled) {
        return
      }

      try {
        await setSettings({
          ...settings,
          chatOptions: {
            ...settings.chatOptions,
            agentYoloEnabled: enabled,
          },
        })
      } catch (error: unknown) {
        console.error('Failed to persist preferred YOLO state', error)
      }
    },
    [setSettings, settings],
  )

  const persistPreferredAssistantId = useCallback(
    async (assistantId: string) => {
      if (settings.currentAssistantId === assistantId) {
        return
      }

      try {
        await setSettings({
          ...settings,
          currentAssistantId: assistantId,
        })
      } catch (error: unknown) {
        console.error('Failed to persist preferred assistant', error)
      }
    },
    [setSettings, settings],
  )

  const persistChatRuntimePreference = useCallback(
    (runtimeId: ChatRuntimeId) => {
      const lastChatSurface = runtimeId === 'yolo' ? 'chat' : 'cli'
      const lastCliRuntimeId =
        runtimeId === 'yolo'
          ? (settings.chatOptions.lastCliRuntimeId ?? 'claude-code')
          : runtimeId
      if (
        settings.chatOptions.lastChatSurface === lastChatSurface &&
        settings.chatOptions.lastCliRuntimeId === lastCliRuntimeId
      ) {
        return
      }
      void setSettings({
        ...settings,
        chatOptions: {
          ...settings.chatOptions,
          lastChatSurface,
          lastCliRuntimeId,
        },
      })
    },
    [setSettings, settings],
  )

  // === 以下依赖 CLI 编排 / 输入控制器 / 会话状态稍后才产生的值,统一经
  // lateStateRef 注入 ===
  const lateStateRef = useRef<ChatRuntimePreferencesLateState | null>(null)
  const getLate = useCallback((): ChatRuntimePreferencesLateState => {
    const late = lateStateRef.current
    if (!late) {
      throw new Error(
        '[YOLO] useChatRuntimePreferences: accessed before Chat.tsx hydrated lateStateRef',
      )
    }
    return late
  }, [])

  const applyAssistantDefaultModel = useCallback(
    (assistantModelId?: string | null) => {
      if (!assistantModelId) {
        return
      }
      const matchedModel = settings.chatModels.find(
        (model) => model.id === assistantModelId,
      )
      if (!matchedModel) {
        return
      }
      const late = getLate()
      late.setConversationModelId(assistantModelId)
      conversationModelIdRef.current.set(
        currentConversationId,
        assistantModelId,
      )
      const nextReasoningLevel =
        late.getReasoningLevelForModelId(assistantModelId)
      late.setReasoningLevel(nextReasoningLevel)
      conversationReasoningLevelRef.current.set(
        currentConversationId,
        nextReasoningLevel,
      )
      late.setInputMessage((prev) => ({
        ...prev,
        reasoningLevel: nextReasoningLevel,
      }))
    },
    [currentConversationId, getLate, settings.chatModels],
  )

  const handleConversationAssistantSelect = useCallback(
    (assistantId: string) => {
      setConversationAssistantId(assistantId)
      conversationAssistantIdRef.current.set(currentConversationId, assistantId)
      void persistPreferredAssistantId(assistantId)
      const assistant = settings.assistants.find(
        (item) => item.id === assistantId,
      )
      applyAssistantDefaultModel(
        resolveAssistantModelId(assistant?.modelId, settings.chatModelId),
      )
    },
    [
      applyAssistantDefaultModel,
      currentConversationId,
      persistPreferredAssistantId,
      setConversationAssistantId,
      settings.assistants,
      settings.chatModelId,
    ],
  )

  const applyChatModeChange = useCallback(
    (nextMode: ChatMode) => {
      const late = getLate()
      late.setChatMode(nextMode)
      late.setConversationOverrides((prev) => ({
        ...(prev ?? {}),
        chatMode: nextMode,
      }))
      conversationOverridesRef.current.set(currentConversationId, {
        ...(conversationOverridesRef.current.get(currentConversationId) ?? {}),
        chatMode: nextMode,
      })
    },
    [currentConversationId, getLate],
  )

  const applyYoloChange = useCallback(
    (enabled: boolean) => {
      const late = getLate()
      late.setYoloEnabled(enabled)
      late.setConversationOverrides((prev) => ({
        ...(prev ?? {}),
        agentYoloEnabled: enabled,
      }))
      conversationOverridesRef.current.set(currentConversationId, {
        ...(conversationOverridesRef.current.get(currentConversationId) ?? {}),
        agentYoloEnabled: enabled,
      })
    },
    [currentConversationId, getLate],
  )

  const handleYoloChange = useCallback(
    (enabled: boolean) => {
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
            applyYoloChange(true)
            void (async () => {
              try {
                await setSettings({
                  ...settings,
                  chatOptions: {
                    ...settings.chatOptions,
                    agentYoloEnabled: true,
                    fullAccessWarningConfirmed: true,
                  },
                })
              } catch (error: unknown) {
                console.error(
                  'Failed to persist YOLO preference and warning confirmation',
                  error,
                )
              }
            })()
          },
        }).open()
        return
      }

      applyYoloChange(enabled)
      void persistPreferredYolo(enabled)
    },
    [app, applyYoloChange, persistPreferredYolo, setSettings, settings, t],
  )

  const handleChatModeChange = useCallback(
    (nextMode: ChatMode) => {
      applyChatModeChange(nextMode)
      void persistPreferredChatMode(nextMode)

      const late = getLate()
      if (
        isAgentChatMode(nextMode) &&
        late.selectedAssistant?.modelId &&
        late.conversationModelId === settings.chatModelId
      ) {
        applyAssistantDefaultModel(late.selectedAssistant.modelId)
      }
    },
    [
      applyAssistantDefaultModel,
      applyChatModeChange,
      getLate,
      persistPreferredChatMode,
      settings,
    ],
  )

  const handleRuntimeChange = useCallback(
    (runtimeId: ChatRuntimeId) => {
      if (runtimeId === activeRuntimeId) return
      if (runtimeId !== 'yolo' && (!cliRuntimeScope || !cliRuntimeAvailable)) {
        return
      }
      const late = getLate()
      cliModeRequestGenerationRef.current += 1
      const isLatestNavigation = beginChatRuntimeNavigation(
        runtimeNavigationGenerationRef,
        () => chatMountedRef.current,
      )

      const applyRuntimeChange = () => {
        if (!isLatestNavigation()) return
        if (runtimeId === 'yolo') {
          late.setConversationOverrides(
            conversationOverridesRef.current.get(currentConversationId) ?? null,
          )
          activeRuntimeIdRef.current = 'yolo'
          setRequestedRuntimeId('yolo')
          persistChatRuntimePreference('yolo')
          return
        }
        if (!cliRuntimeScope) return
        conversationOverridesRef.current.set(
          late.activeHistoryConversationId,
          late.conversationOverrides,
        )
        const controller = cliRuntimeScope.selectConversationRuntime(runtimeId)
        if (!controller.getSnapshot().sessionRef) {
          controller.stageConfiguration(
            resolveCliRuntimePreference(
              late.cliPreferenceSettingsRef.current,
              runtimeId,
              late.cliModelCatalog.get(runtimeId) ?? [],
            ),
          )
        }
        const nextCliConversationId = uuidv4()
        late.setCliConversationController(controller)
        late.setCliConversationId(nextCliConversationId)
        late.setConversationOverrides(null)
        lastCliRuntimeIdRef.current = runtimeId
        activeRuntimeIdRef.current = runtimeId
        setRequestedRuntimeId(runtimeId)
        persistChatRuntimePreference(runtimeId)
        const modePreference = resolveCliModePreference(
          late.cliPreferenceSettingsRef.current,
          runtimeId,
          conversationOverridesRef.current.get(nextCliConversationId) ?? null,
        )
        late.setCliChatMode(modePreference.mode)
        late.setCliYoloEnabled(modePreference.yoloEnabled)
      }

      if (activeRuntimeId === 'yolo') {
        try {
          applyRuntimeChange()
        } catch (error) {
          new Notice(
            t(
              'chat.cliSurface.runtimeError',
              'Could not start the CLI runtime: {message}',
            ).replace(
              '{message}',
              error instanceof Error ? error.message : String(error),
            ),
          )
        }
        return
      }

      void late.transitionCliSession((isCurrent) => {
        if (!isCurrent() || !isLatestNavigation()) return
        applyRuntimeChange()
      })
    },
    [
      activeRuntimeId,
      chatMountedRef,
      cliRuntimeAvailable,
      cliRuntimeScope,
      currentConversationId,
      getLate,
      persistChatRuntimePreference,
      t,
    ],
  )

  return {
    // 运行时切换状态
    activeRuntimeId,
    activeRuntimeIdRef,
    setRequestedRuntimeId,
    lastCliRuntimeIdRef,
    initialActiveRuntimeId,
    initialCliModePreference,
    cliModeRequestGenerationRef,
    prePlanCliModeByConversationRef,
    runtimeNavigationGenerationRef,
    handleRuntimeChange,

    // 每会话偏好缓存
    conversationModelIdRef,
    conversationReasoningLevelRef,
    conversationAssistantIdRef,
    conversationOverridesRef,

    // persist* 全族
    persistReasoningLevelForModel,
    persistChatRuntimePreference,

    // assistant / mode / yolo 处理器
    applyAssistantDefaultModel,
    handleConversationAssistantSelect,
    handleChatModeChange,
    handleYoloChange,

    lateStateRef,
  }
}
