import { useLanguage } from '../../../contexts/language-context'
import {
  type CliRuntimeConfiguration,
  type CliRuntimeId,
  type CliRuntimeModel,
  getCliRuntimeDescriptor,
} from '../../../core/cli-runtime'
import type { ChatModel } from '../../../types/chat-model.types'
import {
  type ReasoningLevel,
  isReasoningLevelString,
} from '../../../types/reasoning'

import { ModelSelect } from './ModelSelect'
import { ReasoningSelect } from './ReasoningSelect'

const LOADING_VALUE = '__yolo_cli_loading__'

/**
 * CLI 会话当前实际使用的模型：会话配置里选中的那个，没选就是 CLI 自报的
 * 默认模型。配置还没加载时用上次缓存的模型列表。输入框的模型选择器和对话
 * 顶部栏的 Agent 胶囊都按这个口径显示。
 */
export function resolveCliSelectedModel(
  configuration: CliRuntimeConfiguration | null,
  cachedModels: readonly CliRuntimeModel[] = [],
): { models: readonly CliRuntimeModel[]; selected: CliRuntimeModel | null } {
  const models = configuration?.models.length
    ? configuration.models
    : cachedModels
  const selected =
    models.find((model) => model.id === configuration?.modelId) ??
    models.find((model) => model.isDefault) ??
    models[0] ??
    null
  return { models, selected }
}

type CliRuntimeControlsProps = {
  configuration: CliRuntimeConfiguration | null
  cachedModels?: readonly CliRuntimeModel[]
  runtimeId: CliRuntimeId
  disabled?: boolean
  onModelChange: (modelId: string | null) => void
  onReasoningEffortChange: (effort: string | null) => void
  /** The runtime's explicit default model; `null` follows the CLI's config. */
  defaultModelId?: string | null
  onToggleDefaultModel?: (modelId: string) => void
}

export function CliRuntimeControls({
  configuration,
  cachedModels = [],
  runtimeId,
  disabled = false,
  onModelChange,
  onReasoningEffortChange,
  defaultModelId = null,
  onToggleDefaultModel,
}: CliRuntimeControlsProps) {
  const { t } = useLanguage()
  const { models, selected: selectedModel } = resolveCliSelectedModel(
    configuration,
    cachedModels,
  )
  const descriptor = getCliRuntimeDescriptor(runtimeId)
  const providerName = t(descriptor.labelKey, descriptor.defaultLabel)
  const providerLabel = providerName.toUpperCase()
  const defaultModelLabel = t(
    'chat.cliControls.defaultModel',
    '{provider} default model',
  ).replace('{provider}', providerName)
  const efforts = selectedModel?.reasoningEfforts ?? []
  const reasoningLevels: ReasoningLevel[] = [
    'auto',
    ...efforts
      .map((effort) => effort.id)
      .filter(isReasoningLevelString)
      .filter((effort) => effort !== 'auto' && effort !== 'off'),
  ]
  const currentReasoningLevel = isReasoningLevelString(
    configuration?.reasoningEffort ?? '',
  )
    ? (configuration?.reasoningEffort as ReasoningLevel)
    : 'auto'
  const reasoningModel: ChatModel | null =
    reasoningLevels.length > 1
      ? {
          providerId: 'cli',
          id: selectedModel?.id ?? 'cli-default',
          model: selectedModel?.id ?? 'cli-default',
          name: selectedModel?.label,
          reasoningType: 'openai',
        }
      : null

  return (
    <div className="yolo-cli-runtime-controls">
      <ModelSelect
        modelId={selectedModel?.id ?? LOADING_VALUE}
        disabled={disabled || !configuration || models.length === 0}
        options={
          models.length > 0
            ? models.map((model) => ({
                id: model.id,
                label: model.label,
                group: providerLabel,
              }))
            : [
                {
                  id: LOADING_VALUE,
                  label: defaultModelLabel,
                  group: providerLabel,
                },
              ]
        }
        onChange={onModelChange}
        defaultOption={
          onToggleDefaultModel && models.length > 0
            ? {
                id: defaultModelId,
                onToggle: onToggleDefaultModel,
                badgeLabel: t('chat.cliControls.defaultBadge', 'Default'),
                setLabel: t('chat.cliControls.setAsDefault', 'Set as default'),
                removeLabel: t(
                  'chat.cliControls.removeDefault',
                  'Remove default',
                ),
              }
            : undefined
        }
        align="center"
        sideOffset={8}
        popover={{
          variant: 'default',
          minWidth: 240,
          maxWidth: 320,
          maxHeight: 560,
        }}
      />
      {reasoningModel ? (
        <ReasoningSelect
          model={reasoningModel}
          value={currentReasoningLevel}
          levels={reasoningLevels}
          disabled={disabled || !configuration}
          onChange={(value) =>
            onReasoningEffortChange(value === 'auto' ? null : value)
          }
          side="top"
          align="center"
          sideOffset={8}
        />
      ) : null}
    </div>
  )
}
