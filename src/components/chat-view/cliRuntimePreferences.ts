import type { MutableRefObject } from 'react'

import type {
  CliChatMode,
  CliRuntimeConfiguration,
  CliRuntimeConfigurationUpdate,
  CliRuntimeId,
  CliRuntimeModel,
} from '../../core/cli-runtime'
import {
  RUNTIME_CAPABILITIES,
  normalizeCliChatMode,
} from '../../core/cli-runtime'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'

export const resolveCliRuntimePreference = (
  settings: YoloSettings,
  runtimeId: CliRuntimeId,
  models: readonly CliRuntimeModel[],
): CliRuntimeConfigurationUpdate => {
  const modelId = settings.chatOptions.cliModelIdByRuntime?.[runtimeId]
  if (
    !modelId ||
    (models.length > 0 && !models.some((model) => model.id === modelId))
  ) {
    return {}
  }
  const reasoningEffort =
    settings.chatOptions.cliReasoningEffortByModel?.[
      `${runtimeId}:${modelId}`
    ] ?? undefined
  return {
    modelId,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }
}

export const rememberCliRuntimeConfiguration = (
  settings: YoloSettings,
  runtimeId: CliRuntimeId,
  configuration: CliRuntimeConfiguration,
): YoloSettings => {
  const cliModelIdByRuntime = {
    ...settings.chatOptions.cliModelIdByRuntime,
  }
  const cliReasoningEffortByModel = {
    ...settings.chatOptions.cliReasoningEffortByModel,
  }
  const modelId = configuration.modelId ?? undefined
  if (modelId) {
    cliModelIdByRuntime[runtimeId] = modelId
    const effortKey = `${runtimeId}:${modelId}`
    if (configuration.reasoningEffort) {
      cliReasoningEffortByModel[effortKey] = configuration.reasoningEffort
    } else {
      Reflect.deleteProperty(cliReasoningEffortByModel, effortKey)
    }
  } else {
    Reflect.deleteProperty(cliModelIdByRuntime, runtimeId)
  }
  return {
    ...settings,
    chatOptions: {
      ...settings.chatOptions,
      cliModelIdByRuntime,
      cliReasoningEffortByModel,
    },
  }
}

export type CliModePreference = {
  mode: CliChatMode
  yoloEnabled: boolean
}

/**
 * Runtimes without plan-mode support never expose Plan in the product
 * surface; collapse stray plan values.
 */
export const normalizeCliModeForRuntime = (
  runtimeId: CliRuntimeId,
  mode: CliChatMode,
): CliChatMode => {
  if (!RUNTIME_CAPABILITIES[runtimeId].supportsPlanMode && mode === 'plan') {
    return 'agent'
  }
  return mode
}

export const resolveCliModePreference = (
  settings: YoloSettings,
  runtimeId: CliRuntimeId,
  overrides?: ConversationOverrideSettings | null,
): CliModePreference => {
  const overrideMode = overrides?.cliChatModeByRuntime?.[runtimeId]
  const overrideYolo = overrides?.cliAgentYoloEnabledByRuntime?.[runtimeId]
  const settingsMode = settings.chatOptions.cliChatModeByRuntime?.[runtimeId]
  const settingsYolo =
    settings.chatOptions.cliAgentYoloEnabledByRuntime?.[runtimeId]

  const mode = normalizeCliModeForRuntime(
    runtimeId,
    normalizeCliChatMode(
      overrideMode === null ? undefined : (overrideMode ?? settingsMode),
      'agent',
    ),
  )
  const yoloEnabled =
    typeof overrideYolo === 'boolean'
      ? overrideYolo
      : typeof settingsYolo === 'boolean'
        ? settingsYolo
        : false

  return {
    mode,
    // YOLO is meaningless in Plan; keep the stored bit but callers should
    // ignore it while mode === 'plan'.
    yoloEnabled: mode === 'plan' ? false : yoloEnabled,
  }
}

export const rememberCliModePreference = (
  settings: YoloSettings,
  runtimeId: CliRuntimeId,
  preference: CliModePreference,
): YoloSettings => {
  const mode = normalizeCliModeForRuntime(runtimeId, preference.mode)
  return {
    ...settings,
    chatOptions: {
      ...settings.chatOptions,
      cliChatModeByRuntime: {
        ...settings.chatOptions.cliChatModeByRuntime,
        [runtimeId]: mode,
      },
      cliAgentYoloEnabledByRuntime: {
        ...settings.chatOptions.cliAgentYoloEnabledByRuntime,
        [runtimeId]: mode === 'plan' ? false : preference.yoloEnabled,
      },
    },
  }
}

export const patchConversationCliModeOverrides = (
  overrides: ConversationOverrideSettings | null | undefined,
  runtimeId: CliRuntimeId,
  preference: CliModePreference,
): ConversationOverrideSettings => {
  const mode = normalizeCliModeForRuntime(runtimeId, preference.mode)
  return {
    ...(overrides ?? {}),
    cliChatModeByRuntime: {
      ...(overrides?.cliChatModeByRuntime ?? {}),
      [runtimeId]: mode,
    },
    cliAgentYoloEnabledByRuntime: {
      ...(overrides?.cliAgentYoloEnabledByRuntime ?? {}),
      [runtimeId]: mode === 'plan' ? false : preference.yoloEnabled,
    },
  }
}

/**
 * Per-conversation memory of the agent-mode config to restore to when a
 * plan-capable CLI runtime (claude-code) leaves Plan mode. Transient —
 * lives only in this ref for the tab's lifetime, never persisted to
 * settings or conversation storage.
 */
export type PrePlanCliModeEntry = { mode: 'agent'; yoloEnabled: boolean }
export type PrePlanCliModeMemory = MutableRefObject<
  Map<string, PrePlanCliModeEntry>
>

/** Records the agent-mode config a conversation had right before entering Plan. */
export const rememberPrePlanCliMode = (
  memory: PrePlanCliModeMemory,
  conversationId: string,
  yoloEnabled: boolean,
): void => {
  memory.current.set(conversationId, { mode: 'agent', yoloEnabled })
}

/** Reads the remembered pre-plan config, defaulting to plain agent mode. */
export const readPrePlanCliMode = (
  memory: PrePlanCliModeMemory,
  conversationId: string,
): PrePlanCliModeEntry =>
  memory.current.get(conversationId) ?? { mode: 'agent', yoloEnabled: false }

/**
 * Drops stale pre-plan memory once a conversation settles on a non-plan
 * mode for a plan-capable runtime — covers both live mode changes
 * (`applyCliModePreference`) and session loads (`loadYoloConversation` /
 * `loadCliConversation`), which previously reimplemented this guard
 * separately.
 */
export const prunePrePlanCliMode = (
  memory: PrePlanCliModeMemory,
  conversationId: string,
  runtimeId: CliRuntimeId,
  mode: CliChatMode,
): void => {
  if (RUNTIME_CAPABILITIES[runtimeId].supportsPlanMode && mode !== 'plan') {
    memory.current.delete(conversationId)
  }
}
