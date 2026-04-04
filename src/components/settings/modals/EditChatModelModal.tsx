import { App, Notice } from 'obsidian'
import React, { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import SmartComposerPlugin from '../../../main'
import { ChatModel } from '../../../types/chat-model.types'
import { CustomParameter } from '../../../types/custom-parameter.types'
import {
  normalizeCustomParameterType,
  sanitizeCustomParameters,
} from '../../../utils/custom-parameters'
import { resolveKnownMaxContextTokens } from '../../../utils/llm/model-context-registry'
import {
  detectReasoningTypeFromModelId,
  ensureUniqueModelId,
  generateModelId,
} from '../../../utils/model-id-utils'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'

type EditChatModelModalComponentProps = {
  plugin: SmartComposerPlugin
  model: ChatModel
}

type CustomParameterFormEntry = CustomParameter & {
  uid: string
}

type EditableChatModel = ChatModel & {
  reasoning?: {
    enabled: boolean
    reasoning_effort?: string
  }
  thinking?: {
    enabled: boolean
    thinking_budget?: number // Gemini, OpenRouter
    budget_tokens?: number // Anthropic
  }
  toolType?: 'none' | 'gemini' | 'gpt'
  customParameters?: CustomParameter[]
}

const TOOL_TYPES = ['none', 'gemini', 'gpt'] as const
type ToolType = (typeof TOOL_TYPES)[number]
const CUSTOM_PARAMETER_TYPES = ['text', 'number', 'boolean', 'json'] as const
const RESERVED_CUSTOM_PARAMETER_KEYS = new Set([
  'temperature',
  'top_p',
  'max_tokens',
  'max_output_tokens',
])

const isReservedCustomParameterKey = (key: string): boolean =>
  RESERVED_CUSTOM_PARAMETER_KEYS.has(key.trim().toLowerCase())

const MODEL_SAMPLING_DEFAULTS = {
  temperature: 0.8,
  topP: 0.9,
  maxContextTokens: 32768,
  maxOutputTokens: 4096,
} as const

const MAX_CONTEXT_TOKENS_INPUT_MAX = 1000000
const MAX_CONTEXT_TOKENS_SLIDER_STEP = 64

const clampTemperature = (value: number): number =>
  Math.min(2, Math.max(0, value))

const clampTopP = (value: number): number => Math.min(1, Math.max(0, value))

const clampMaxContextTokens = (value: number): number =>
  Math.max(1, Math.floor(value))

const formatIntegerWithGrouping = (value: string): string => {
  if (value.length === 0) {
    return ''
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(Number(value))
}

const clampMaxOutputTokens = (value: number): number =>
  Math.max(1, Math.floor(value))

export class EditChatModelModal extends ReactModal<EditChatModelModalComponentProps> {
  constructor(app: App, plugin: SmartComposerPlugin, model: ChatModel) {
    super({
      app: app,
      Component: EditChatModelModalComponent,
      props: { plugin, model },
      options: {
        title: 'Edit custom chat model', // Will be translated in component
      },
      plugin: plugin,
    })
  }
}

function EditChatModelModalComponent({
  plugin,
  onClose,
  model,
}: EditChatModelModalComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const editableModel: EditableChatModel = model
  const selectedProvider = plugin.settings.providers.find(
    (provider) => provider.id === model.providerId,
  )

  const normalizeReasoningType = (
    value: string,
  ): 'none' | 'openai' | 'gemini' | 'anthropic' | 'generic' => {
    if (
      value === 'openai' ||
      value === 'gemini' ||
      value === 'anthropic' ||
      value === 'generic'
    ) {
      return value
    }
    return 'none'
  }

  const normalizeToolType = (value: string): ToolType =>
    TOOL_TYPES.includes(value as ToolType) ? (value as ToolType) : 'none'

  const supportsGeminiTools =
    selectedProvider?.apiType === 'gemini' ||
    selectedProvider?.apiType === 'openai-compatible'
  const supportsGptTools =
    selectedProvider?.apiType === 'openai-compatible' ||
    selectedProvider?.apiType === 'openai-responses'

  // Update modal title
  React.useEffect(() => {
    const modalEl = document.querySelector('.modal .modal-title')
    if (modalEl) {
      modalEl.textContent = t('settings.models.editCustomChatModel')
    }
  }, [t])
  const [formData, setFormData] = useState<{
    model: string
    name: string
  }>({
    model: model.model,
    name: model.name ?? '',
  })

  const initialReasoningType:
    | 'none'
    | 'openai'
    | 'gemini'
    | 'anthropic'
    | 'generic' = (() => {
    if (editableModel.reasoningType && editableModel.reasoningType !== 'none') {
      return editableModel.reasoningType
    }
    if (editableModel.reasoning?.enabled) return 'openai'
    if (editableModel.thinking?.enabled) {
      if (typeof editableModel.thinking.budget_tokens === 'number')
        return 'anthropic'
      if (typeof editableModel.thinking.thinking_budget === 'number')
        return 'gemini'
      return 'generic'
    }
    return 'none'
  })()

  // Reasoning UI states
  const [reasoningType, setReasoningType] = useState<
    'none' | 'openai' | 'gemini' | 'anthropic' | 'generic'
  >(() => initialReasoningType)
  // If user changes dropdown manually, disable auto detection
  const [autoDetectReasoning, setAutoDetectReasoning] = useState<boolean>(true)

  // Tool type state
  const [toolType, setToolType] = useState<ToolType>(
    normalizeToolType(editableModel.toolType ?? 'none'),
  )
  const [gptWebSearchEnabled, setGptWebSearchEnabled] = useState<boolean>(
    editableModel.gptTools?.webSearch?.enabled === true,
  )
  const resolvedKnownMaxContextTokens = resolveKnownMaxContextTokens(
    model.model,
  )
  const [modelParamCache, setModelParamCache] = useState<{
    temperature: number
    topP: number
    maxContextTokens: number
    maxOutputTokens: number
  }>(() => ({
    temperature:
      editableModel.temperature ?? MODEL_SAMPLING_DEFAULTS.temperature,
    topP: editableModel.topP ?? MODEL_SAMPLING_DEFAULTS.topP,
    maxContextTokens:
      editableModel.maxContextTokens ??
      resolvedKnownMaxContextTokens ??
      MODEL_SAMPLING_DEFAULTS.maxContextTokens,
    maxOutputTokens:
      editableModel.maxOutputTokens ?? MODEL_SAMPLING_DEFAULTS.maxOutputTokens,
  }))
  const [temperature, setTemperature] = useState<number | undefined>(
    editableModel.temperature,
  )
  const [topP, setTopP] = useState<number | undefined>(editableModel.topP)
  const [maxContextTokens, setMaxContextTokens] = useState<number | undefined>(
    editableModel.maxContextTokens ?? resolvedKnownMaxContextTokens,
  )
  const [maxContextTokensInput, setMaxContextTokensInput] = useState<string>(
    () =>
      String(
        editableModel.maxContextTokens ??
          resolvedKnownMaxContextTokens ??
          modelParamCache.maxContextTokens,
      ),
  )
  const [isMaxContextTokensInputFocused, setIsMaxContextTokensInputFocused] =
    useState(false)
  const [maxOutputTokens, setMaxOutputTokens] = useState<number | undefined>(
    editableModel.maxOutputTokens,
  )
  const [hasManualMaxContextTokens, setHasManualMaxContextTokens] =
    useState<boolean>(false)
  const customParameterUidRef = React.useRef(0)
  const createCustomParameterUid = (): string => {
    customParameterUidRef.current += 1
    return `custom-param-${customParameterUidRef.current}`
  }
  const [customParameters, setCustomParameters] = useState<
    CustomParameterFormEntry[]
  >(() =>
    Array.isArray(editableModel.customParameters)
      ? editableModel.customParameters
          .filter((entry) => !isReservedCustomParameterKey(entry.key))
          .map((entry) => ({
            ...entry,
            uid: createCustomParameterUid(),
          }))
      : [],
  )

  const resetModelParams = () => {
    setModelParamCache({
      temperature: MODEL_SAMPLING_DEFAULTS.temperature,
      topP: MODEL_SAMPLING_DEFAULTS.topP,
      maxContextTokens:
        resolveKnownMaxContextTokens(formData.model) ??
        MODEL_SAMPLING_DEFAULTS.maxContextTokens,
      maxOutputTokens: MODEL_SAMPLING_DEFAULTS.maxOutputTokens,
    })
    setTemperature(MODEL_SAMPLING_DEFAULTS.temperature)
    setTopP(MODEL_SAMPLING_DEFAULTS.topP)
    setMaxContextTokens(resolveKnownMaxContextTokens(formData.model))
    setMaxOutputTokens(MODEL_SAMPLING_DEFAULTS.maxOutputTokens)
    setHasManualMaxContextTokens(false)
  }

  React.useEffect(() => {
    if (hasManualMaxContextTokens) {
      return
    }

    const matched = resolveKnownMaxContextTokens(formData.model)
    const nextMaxContextTokens =
      formData.model === editableModel.model &&
      typeof editableModel.maxContextTokens === 'number'
        ? editableModel.maxContextTokens
        : matched

    setModelParamCache((prev) => ({
      ...prev,
      maxContextTokens:
        nextMaxContextTokens ?? MODEL_SAMPLING_DEFAULTS.maxContextTokens,
    }))
    setMaxContextTokens(nextMaxContextTokens)
  }, [
    editableModel.maxContextTokens,
    editableModel.model,
    formData.model,
    hasManualMaxContextTokens,
  ])

  useEffect(() => {
    if (typeof maxContextTokens === 'number') {
      setMaxContextTokensInput(String(maxContextTokens))
    }
  }, [maxContextTokens])

  const updateMaxContextTokens = (value: number) => {
    const clamped = clampMaxContextTokens(value)
    setHasManualMaxContextTokens(true)
    setModelParamCache((prev) => ({
      ...prev,
      maxContextTokens: clamped,
    }))
    setMaxContextTokens(clamped)
    setMaxContextTokensInput(String(clamped))
  }

  const setTemperatureEnabled = (enabled: boolean) => {
    const current = temperature ?? modelParamCache.temperature
    setModelParamCache((prev) => ({ ...prev, temperature: current }))
    setTemperature(enabled ? current : undefined)
  }

  const setTopPEnabled = (enabled: boolean) => {
    const current = topP ?? modelParamCache.topP
    setModelParamCache((prev) => ({ ...prev, topP: current }))
    setTopP(enabled ? current : undefined)
  }

  const setMaxOutputTokensEnabled = (enabled: boolean) => {
    const current = maxOutputTokens ?? modelParamCache.maxOutputTokens
    setModelParamCache((prev) => ({ ...prev, maxOutputTokens: current }))
    setMaxOutputTokens(enabled ? current : undefined)
  }

  const setMaxContextTokensEnabled = (enabled: boolean) => {
    const current = maxContextTokens ?? modelParamCache.maxContextTokens
    setHasManualMaxContextTokens(true)
    setModelParamCache((prev) => ({ ...prev, maxContextTokens: current }))
    setMaxContextTokens(enabled ? current : undefined)
  }

  const handleSubmit = () => {
    if (!formData.model.trim()) {
      new Notice(t('common.error'))
      return
    }

    const execute = async () => {
      try {
        const settings = plugin.settings
        const chatModels = [...settings.chatModels]
        const modelIndex = chatModels.findIndex((m) => m.id === model.id)

        if (modelIndex === -1) {
          new Notice('Model not found')
          return
        }

        // Compute new internal id from provider + API model id (calling ID)
        const baseInternalId = generateModelId(model.providerId, formData.model)
        const existingIds = chatModels
          .map((m) => m.id)
          .filter((id) => id !== model.id)
        const newInternalId = ensureUniqueModelId(existingIds, baseInternalId)

        // Compose reasoning/thinking fields based on selection and provider
        const updatedModel: EditableChatModel = {
          ...chatModels[modelIndex],
          id: newInternalId,
          model: formData.model,
          name:
            formData.name && formData.name.trim().length > 0
              ? formData.name
              : undefined,
          temperature,
          topP,
          maxContextTokens,
          maxOutputTokens,
        }

        // Apply according to selected reasoningType only (not limited by providerType)
        if (reasoningType === 'openai') {
          updatedModel.reasoningType = 'openai'
          delete updatedModel.reasoning
          delete updatedModel.thinking
        } else if (
          reasoningType === 'gemini' ||
          reasoningType === 'anthropic'
        ) {
          updatedModel.reasoningType = reasoningType
          delete updatedModel.reasoning
          delete updatedModel.thinking
        } else if (reasoningType === 'generic') {
          updatedModel.reasoningType = 'generic'
          delete updatedModel.reasoning
          delete updatedModel.thinking
        } else {
          delete updatedModel.reasoning
          delete updatedModel.thinking
          updatedModel.reasoningType = 'none'
        }

        // Apply tool type
        updatedModel.toolType = toolType
        updatedModel.gptTools = {
          webSearch: {
            enabled: gptWebSearchEnabled,
          },
        }

        const sanitizedCustomParameters = sanitizeCustomParameters(
          customParameters,
        ).filter((entry) => !isReservedCustomParameterKey(entry.key))

        if (sanitizedCustomParameters.length > 0) {
          updatedModel.customParameters = sanitizedCustomParameters
        } else {
          delete updatedModel.customParameters
        }

        // Update the model
        chatModels[modelIndex] = updatedModel

        // Update references if current selection points to the old id
        const nextSettings = { ...settings, chatModels }
        if (nextSettings.chatModelId === model.id) {
          nextSettings.chatModelId = newInternalId
        }
        if (nextSettings.chatTitleModelId === model.id) {
          nextSettings.chatTitleModelId = newInternalId
        }

        await plugin.setSettings(nextSettings)

        new Notice(t('common.success'))
        onClose()
      } catch (error) {
        console.error('Failed to update chat model:', error)
        new Notice(t('common.error'))
      }
    }

    void execute()
  }

  return (
    <div className="smtcmp-chat-model-modal-form">
      <ObsidianSetting
        name={t('settings.models.modelId')}
        desc={t('settings.models.modelIdDesc')}
        required
      >
        <ObsidianTextInput
          value={formData.model}
          placeholder={t('settings.models.modelIdPlaceholder')}
          onChange={(value: string) => {
            setFormData((prev) => ({ ...prev, model: value }))
            if (autoDetectReasoning) {
              const detected = detectReasoningTypeFromModelId(value)
              setReasoningType(detected)
            }
          }}
        />
      </ObsidianSetting>

      {/* Display name (move right below modelId) */}
      <ObsidianSetting name={t('settings.models.modelName')}>
        <ObsidianTextInput
          value={formData.name}
          placeholder={t('settings.models.modelNamePlaceholder')}
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, name: value }))
          }
        />
      </ObsidianSetting>

      {/* Reasoning type */}
      <ObsidianSetting name={t('settings.models.reasoningType')}>
        <ObsidianDropdown
          value={reasoningType}
          options={{
            none: t('settings.models.reasoningTypeNone'),
            openai: t('settings.models.reasoningTypeOpenAI'),
            gemini: t('settings.models.reasoningTypeGemini'),
            anthropic: t('settings.models.reasoningTypeAnthropic'),
            generic: t('settings.models.reasoningTypeGeneric'),
          }}
          onChange={(v: string) => {
            setReasoningType(normalizeReasoningType(v))
            setAutoDetectReasoning(false)
          }}
        />
      </ObsidianSetting>

      {/* Reasoning strength is controlled in the chat sidebar */}
      {(supportsGeminiTools || supportsGptTools) && (
        <ObsidianSetting
          name={t('settings.models.toolType')}
          desc={t('settings.models.toolTypeDesc')}
        >
          <ObsidianDropdown
            value={toolType}
            options={Object.fromEntries(
              [
                ['none', t('settings.models.toolTypeNone')],
                supportsGeminiTools
                  ? ['gemini', t('settings.models.toolTypeGemini')]
                  : null,
                supportsGptTools
                  ? ['gpt', t('settings.models.toolTypeGpt')]
                  : null,
              ].filter((entry): entry is [string, string] => entry !== null),
            )}
            onChange={(v: string) => setToolType(normalizeToolType(v))}
          />
        </ObsidianSetting>
      )}

      {toolType === 'gpt' && supportsGptTools && (
        <div className="smtcmp-agent-tools-panel smtcmp-agent-model-panel">
          <div className="smtcmp-agent-tools-panel-head smtcmp-agent-model-panel-head">
            <div className="smtcmp-agent-tools-panel-title">
              {t('settings.models.gptTools')}
            </div>
          </div>

          <div className="smtcmp-agent-model-controls">
            <div className="smtcmp-agent-model-control">
              <div className="smtcmp-agent-model-control-top">
                <div className="smtcmp-agent-model-control-meta">
                  <div className="smtcmp-agent-model-control-label">
                    {t('settings.models.gptToolWebSearch')}
                  </div>
                  <div className="smtcmp-agent-model-control-desc">
                    {t('settings.models.gptToolWebSearchDesc')}
                  </div>
                </div>
                <div className="smtcmp-agent-model-control-actions">
                  <ObsidianToggle
                    value={gptWebSearchEnabled}
                    onChange={setGptWebSearchEnabled}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="smtcmp-agent-tools-panel smtcmp-agent-model-panel">
        <div className="smtcmp-agent-tools-panel-head smtcmp-agent-model-panel-head">
          <div className="smtcmp-agent-tools-panel-title">
            {t('settings.models.customParameters', 'Custom parameters')}
          </div>
          <button
            type="button"
            className="smtcmp-agent-model-reset"
            onClick={resetModelParams}
          >
            {t('settings.models.restoreDefaults', 'Restore defaults')}
          </button>
        </div>

        <div className="smtcmp-agent-model-controls">
          <div
            className={`smtcmp-agent-model-control${
              maxContextTokens === undefined ? ' is-disabled' : ''
            }`}
          >
            <div className="smtcmp-agent-model-control-top">
              <div className="smtcmp-agent-model-control-meta">
                <div className="smtcmp-agent-model-control-label">
                  {t(
                    'settings.models.maxContextTokens',
                    'Context window tokens',
                  )}
                </div>
                <div className="smtcmp-agent-model-control-desc">
                  {t(
                    'settings.models.maxContextTokensDesc',
                    'Auto-filled when this model is recognized. Adjust it if your provider uses a different limit.',
                  )}
                </div>
              </div>
              <div className="smtcmp-agent-model-control-actions">
                <ObsidianToggle
                  value={maxContextTokens !== undefined}
                  onChange={setMaxContextTokensEnabled}
                />
              </div>
            </div>
            {maxContextTokens !== undefined && (
              <div className="smtcmp-agent-model-control-adjust">
                <input
                  type="range"
                  min={1024}
                  max={MAX_CONTEXT_TOKENS_INPUT_MAX}
                  step={MAX_CONTEXT_TOKENS_SLIDER_STEP}
                  value={Math.min(
                    MAX_CONTEXT_TOKENS_INPUT_MAX,
                    Math.max(
                      1024,
                      maxContextTokens ?? modelParamCache.maxContextTokens,
                    ),
                  )}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value)
                    if (!Number.isFinite(next)) {
                      return
                    }
                    updateMaxContextTokens(next)
                  }}
                />
                <input
                  type="text"
                  className="smtcmp-agent-model-number"
                  inputMode="numeric"
                  value={
                    isMaxContextTokensInputFocused
                      ? maxContextTokensInput
                      : formatIntegerWithGrouping(maxContextTokensInput)
                  }
                  onChange={(event) => {
                    const nextValue = event.currentTarget.value
                    if (!/^\d*$/.test(nextValue)) {
                      return
                    }
                    setMaxContextTokensInput(nextValue)
                    if (nextValue === '') {
                      return
                    }
                    updateMaxContextTokens(Number(nextValue))
                  }}
                  onFocus={() => {
                    setIsMaxContextTokensInputFocused(true)
                  }}
                  onBlur={() => {
                    setIsMaxContextTokensInputFocused(false)
                    if (maxContextTokensInput !== '') {
                      return
                    }
                    setMaxContextTokensInput(
                      String(
                        maxContextTokens ?? modelParamCache.maxContextTokens,
                      ),
                    )
                  }}
                />
              </div>
            )}
          </div>

          <div
            className={`smtcmp-agent-model-control${
              temperature === undefined ? ' is-disabled' : ''
            }`}
          >
            <div className="smtcmp-agent-model-control-top">
              <div className="smtcmp-agent-model-control-meta">
                <div className="smtcmp-agent-model-control-label">
                  {t(
                    'settings.conversationSettings.temperature',
                    'Temperature',
                  )}
                </div>
              </div>
              <div className="smtcmp-agent-model-control-actions">
                <ObsidianToggle
                  value={temperature !== undefined}
                  onChange={setTemperatureEnabled}
                />
              </div>
            </div>
            {temperature !== undefined && (
              <div className="smtcmp-agent-model-control-adjust">
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={temperature ?? modelParamCache.temperature}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value)
                    if (!Number.isFinite(next)) {
                      return
                    }
                    const clamped = clampTemperature(next)
                    setModelParamCache((prev) => ({
                      ...prev,
                      temperature: clamped,
                    }))
                    setTemperature(clamped)
                  }}
                />
                <input
                  type="number"
                  className="smtcmp-agent-model-number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature ?? modelParamCache.temperature}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value)
                    if (!Number.isFinite(next)) {
                      return
                    }
                    const clamped = clampTemperature(next)
                    setModelParamCache((prev) => ({
                      ...prev,
                      temperature: clamped,
                    }))
                    setTemperature(clamped)
                  }}
                />
              </div>
            )}
          </div>

          <div
            className={`smtcmp-agent-model-control${
              topP === undefined ? ' is-disabled' : ''
            }`}
          >
            <div className="smtcmp-agent-model-control-top">
              <div className="smtcmp-agent-model-control-meta">
                <div className="smtcmp-agent-model-control-label">
                  {t('settings.conversationSettings.topP', 'Top P')}
                </div>
              </div>
              <div className="smtcmp-agent-model-control-actions">
                <ObsidianToggle
                  value={topP !== undefined}
                  onChange={setTopPEnabled}
                />
              </div>
            </div>
            {topP !== undefined && (
              <div className="smtcmp-agent-model-control-adjust">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={topP ?? modelParamCache.topP}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value)
                    if (!Number.isFinite(next)) {
                      return
                    }
                    const clamped = clampTopP(next)
                    setModelParamCache((prev) => ({ ...prev, topP: clamped }))
                    setTopP(clamped)
                  }}
                />
                <input
                  type="number"
                  className="smtcmp-agent-model-number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={topP ?? modelParamCache.topP}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value)
                    if (!Number.isFinite(next)) {
                      return
                    }
                    const clamped = clampTopP(next)
                    setModelParamCache((prev) => ({ ...prev, topP: clamped }))
                    setTopP(clamped)
                  }}
                />
              </div>
            )}
          </div>

          <div
            className={`smtcmp-agent-model-control${
              maxOutputTokens === undefined ? ' is-disabled' : ''
            }`}
          >
            <div className="smtcmp-agent-model-control-top">
              <div className="smtcmp-agent-model-control-meta">
                <div className="smtcmp-agent-model-control-label">
                  {t('settings.models.maxOutputTokens', 'Max output tokens')}
                </div>
              </div>
              <div className="smtcmp-agent-model-control-actions">
                <ObsidianToggle
                  value={maxOutputTokens !== undefined}
                  onChange={setMaxOutputTokensEnabled}
                />
              </div>
            </div>
            {maxOutputTokens !== undefined && (
              <div className="smtcmp-agent-model-control-adjust">
                <input
                  type="range"
                  min={256}
                  max={32768}
                  step={256}
                  value={Math.min(
                    32768,
                    Math.max(
                      256,
                      maxOutputTokens ?? modelParamCache.maxOutputTokens,
                    ),
                  )}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value)
                    if (!Number.isFinite(next)) {
                      return
                    }
                    const clamped = clampMaxOutputTokens(next)
                    setModelParamCache((prev) => ({
                      ...prev,
                      maxOutputTokens: clamped,
                    }))
                    setMaxOutputTokens(clamped)
                  }}
                />
                <input
                  type="number"
                  className="smtcmp-agent-model-number"
                  min={1}
                  step={1}
                  value={maxOutputTokens ?? modelParamCache.maxOutputTokens}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value)
                    if (!Number.isFinite(next)) {
                      return
                    }
                    const clamped = clampMaxOutputTokens(next)
                    setModelParamCache((prev) => ({
                      ...prev,
                      maxOutputTokens: clamped,
                    }))
                    setMaxOutputTokens(clamped)
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <ObsidianSetting
        name={t('settings.models.customParameters')}
        desc={t('settings.models.customParametersDesc')}
      >
        <ObsidianButton
          text={t('settings.models.customParametersAdd')}
          onClick={() =>
            setCustomParameters((prev) => [
              ...prev,
              {
                uid: createCustomParameterUid(),
                key: '',
                value: '',
                type: 'text',
              },
            ])
          }
        />
      </ObsidianSetting>

      {customParameters.map((param, index) => (
        <ObsidianSetting
          key={param.uid}
          className="smtcmp-settings-kv-entry smtcmp-settings-kv-entry--inline"
        >
          <ObsidianTextInput
            value={param.key}
            placeholder={t('settings.models.customParametersKeyPlaceholder')}
            onChange={(value: string) =>
              setCustomParameters((prev) => {
                const next = [...prev]
                next[index] = { ...next[index], key: value }
                return next
              })
            }
          />
          <ObsidianDropdown
            value={normalizeCustomParameterType(param.type)}
            options={Object.fromEntries(
              CUSTOM_PARAMETER_TYPES.map((type) => [
                type,
                t(
                  `settings.models.customParameterType${
                    type.charAt(0).toUpperCase() + type.slice(1)
                  }`,
                  type,
                ),
              ]),
            )}
            onChange={(value: string) =>
              setCustomParameters((prev) => {
                const next = [...prev]
                next[index] = {
                  ...next[index],
                  type: normalizeCustomParameterType(value),
                }
                return next
              })
            }
          />
          <ObsidianTextInput
            value={param.value}
            placeholder={t('settings.models.customParametersValuePlaceholder')}
            onChange={(value: string) =>
              setCustomParameters((prev) => {
                const next = [...prev]
                next[index] = { ...next[index], value }
                return next
              })
            }
          />
          <ObsidianButton
            text={t('common.remove')}
            onClick={() =>
              setCustomParameters((prev) =>
                prev.filter((_, removeIndex) => removeIndex !== index),
              )
            }
          />
        </ObsidianSetting>
      ))}

      <ObsidianSetting>
        <ObsidianButton text={t('common.save')} onClick={handleSubmit} cta />
        <ObsidianButton text={t('common.cancel')} onClick={onClose} />
      </ObsidianSetting>
    </div>
  )
}
