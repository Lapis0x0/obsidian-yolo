import type {
  CliRuntimeConfiguration,
  CliRuntimeId,
} from '../../../core/cli-runtime'
import { useLanguage } from '../../../contexts/language-context'
import type { ChatModel } from '../../../types/chat-model.types'
import {
  type ReasoningLevel,
  isReasoningLevelString,
} from '../../../types/reasoning'

import { ModelSelect } from './ModelSelect'
import { ReasoningSelect } from './ReasoningSelect'

const LOADING_VALUE = '__yolo_cli_loading__'

type CliRuntimeControlsProps = {
  configuration: CliRuntimeConfiguration | null
  runtimeId: CliRuntimeId
  disabled?: boolean
  onModelChange: (modelId: string | null) => void
  onReasoningEffortChange: (effort: string | null) => void
}

export function CliRuntimeControls({
  configuration,
  runtimeId,
  disabled = false,
  onModelChange,
  onReasoningEffortChange,
}: CliRuntimeControlsProps) {
  const { t } = useLanguage()
  const models = configuration?.models ?? []
  const providerLabel = runtimeId === 'codex' ? 'CODEX' : 'CLAUDE CODE'
  const selectedModel =
    models.find((model) => model.id === configuration?.modelId) ??
    models.find((model) => model.isDefault) ??
    models[0] ??
    null
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
        disabled={disabled || !configuration}
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
                  label: t('chat.cliControls.loadingModels', '加载模型…'),
                  group: providerLabel,
                },
              ]
        }
        onChange={onModelChange}
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
