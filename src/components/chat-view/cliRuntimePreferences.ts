import type {
  CliRuntimeConfiguration,
  CliRuntimeConfigurationUpdate,
  CliRuntimeId,
  CliRuntimeModel,
} from '../../core/cli-runtime'
import type { YoloSettings } from '../../settings/schema/setting.types'

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
