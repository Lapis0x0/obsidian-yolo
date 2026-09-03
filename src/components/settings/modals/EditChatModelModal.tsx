import { FileText, Image as ImageIcon, Type } from 'lucide-react'
import { App, Notice } from 'obsidian'
import React, { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type YoloPlugin from '../../../main'
import { ChatModel, ChatModelModality } from '../../../types/chat-model.types'
import { CustomParameter } from '../../../types/custom-parameter.types'
import {
  normalizeCustomParameterType,
  sanitizeCustomParameters,
} from '../../../utils/custom-parameters'
import { formatIntegerWithGrouping } from '../../../utils/formatIntegerWithGrouping'
import { resolveKnownMaxContextTokens } from '../../../utils/llm/model-capability-registry'
import { resolveDefaultChatModelModalities } from '../../../utils/llm/model-modalities'
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
import { ModelRequestParametersDisclosure } from '../common/ModelRequestParametersDisclosure'

type EditChatModelModalComponentProps = {
  plugin: YoloPlugin
  model: ChatModel
}

type CustomParameterFormEntry = CustomParameter & {
  uid: string
}

const BUILTIN_TOOL_PROVIDERS = [
  'none',
  'gemini',
  'gpt',
  'openrouter',
  'grok',
  'deepseek',
] as const
type BuiltinToolProvider = (typeof BUILTIN_TOOL_PROVIDERS)[number]

const OPENROUTER_WEB_SEARCH_ENGINES = [
  'auto',
  'native',
  'exa',
  'firecrawl',
  'parallel',
] as const
type OpenRouterWebSearchEngine = (typeof OPENROUTER_WEB_SEARCH_ENGINES)[number]
const isOpenRouterWebSearchEngine = (
  value: string,
): value is OpenRouterWebSearchEngine =>
  (OPENROUTER_WEB_SEARCH_ENGINES as readonly string[]).includes(value)
const OPENROUTER_MAX_RESULTS_MIN = 1
const OPENROUTER_MAX_RESULTS_MAX = 25
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
const MAX_OUTPUT_TOKENS_SLIDER_MAX = 393216 // 384K, supports DeepSeek v4 and similar models

const clampTemperature = (value: number): number =>
  Math.min(2, Math.max(0, value))

const clampTopP = (value: number): number => Math.min(1, Math.max(0, value))

const clampMaxContextTokens = (value: number): number =>
  Math.max(1, Math.floor(value))

const clampMaxOutputTokens = (value: number): number =>
  Math.max(1, Math.floor(value))

export class EditChatModelModal extends ReactModal<EditChatModelModalComponentProps> {
  constructor(app: App, plugin: YoloPlugin, model: ChatModel) {
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
  const editableModel = model
  const selectedProvider = plugin.settings.providers.find(
    (provider) => provider.id === model.providerId,
  )

  const normalizeReasoningType = (
    value: string,
  ): 'none' | 'openai' | 'gemini' | 'anthropic' => {
    if (value === 'openai' || value === 'gemini' || value === 'anthropic') {
      return value
    }
    return 'none'
  }

  const normalizeBuiltinToolProvider = (value: string): BuiltinToolProvider =>
    BUILTIN_TOOL_PROVIDERS.includes(value as BuiltinToolProvider)
      ? (value as BuiltinToolProvider)
      : 'none'

  // Provider–family alignment is the user's responsibility (per upstream
  // request): every family is selectable on every model, and downstream
  // provider clients only forward families the gateway recognises. We still
  // surface a hint so users understand that picking a family the gateway
  // doesn't support is a silent no-op rather than a guaranteed success.

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

  const initialReasoningType: 'none' | 'openai' | 'gemini' | 'anthropic' =
    (() => {
      if (
        editableModel.reasoningType &&
        editableModel.reasoningType !== 'none'
      ) {
        return editableModel.reasoningType
      }
      return normalizeReasoningType(
        detectReasoningTypeFromModelId(editableModel.model),
      )
    })()

  // Reasoning UI states
  const [reasoningType, setReasoningType] = useState<
    'none' | 'openai' | 'gemini' | 'anthropic'
  >(() => initialReasoningType)
  // If user changes dropdown manually, disable auto detection
  const [autoDetectReasoning, setAutoDetectReasoning] = useState<boolean>(true)

  // Built-in (hosted) provider tools state — note: this is intentionally
  // unrelated to function-calling tools the agent runs. See ChatModel.
  const [builtinToolProvider, setBuiltinToolProvider] =
    useState<BuiltinToolProvider>(
      normalizeBuiltinToolProvider(editableModel.builtinToolProvider ?? 'none'),
    )
  React.useEffect(() => {
    if (
      selectedProvider?.presetType === 'openrouter' &&
      builtinToolProvider !== 'none' &&
      builtinToolProvider !== 'openrouter'
    ) {
      setBuiltinToolProvider('none')
    }
    if (
      selectedProvider?.presetType !== 'deepseek' &&
      builtinToolProvider === 'deepseek'
    ) {
      setBuiltinToolProvider('none')
    }
    if (
      selectedProvider?.presetType === 'deepseek' &&
      builtinToolProvider !== 'none' &&
      builtinToolProvider !== 'deepseek'
    ) {
      setBuiltinToolProvider('none')
    }
  }, [selectedProvider?.presetType, builtinToolProvider])
  // DeepSeek only exposes its hosted search on the Anthropic and Responses
  // transports; `chat/completions` rejects hosted tool types outright.
  const isDeepSeekWebSearchSupported =
    selectedProvider?.apiType === 'anthropic' ||
    selectedProvider?.apiType === 'openai-responses'
  const [gptWebSearchEnabled, setGptWebSearchEnabled] = useState<boolean>(
    editableModel.builtinTools?.gpt?.webSearch?.enabled === true,
  )
  const [openRouterWebSearchEnabled, setOpenRouterWebSearchEnabled] =
    useState<boolean>(
      editableModel.builtinTools?.openrouter?.webSearch?.enabled === true,
    )
  const [openRouterWebSearchEngine, setOpenRouterWebSearchEngine] =
    useState<OpenRouterWebSearchEngine>(() => {
      const raw = editableModel.builtinTools?.openrouter?.webSearch?.engine
      return raw && isOpenRouterWebSearchEngine(raw) ? raw : 'auto'
    })
  const initialOpenRouterMaxResults =
    editableModel.builtinTools?.openrouter?.webSearch?.maxResults
  const [
    openRouterWebSearchMaxResultsInput,
    setOpenRouterWebSearchMaxResultsInput,
  ] = useState<string>(
    typeof initialOpenRouterMaxResults === 'number'
      ? String(initialOpenRouterMaxResults)
      : '',
  )
  const [grokWebSearchEnabled, setGrokWebSearchEnabled] = useState<boolean>(
    editableModel.builtinTools?.grok?.webSearch?.enabled === true,
  )
  const [geminiWebSearchEnabled, setGeminiWebSearchEnabled] = useState<boolean>(
    editableModel.builtinTools?.gemini?.webSearch?.enabled === true,
  )
  const [geminiUrlContextEnabled, setGeminiUrlContextEnabled] =
    useState<boolean>(
      editableModel.builtinTools?.gemini?.urlContext?.enabled === true,
    )
  const [deepseekWebSearchEnabled, setDeepseekWebSearchEnabled] =
    useState<boolean>(
      editableModel.builtinTools?.deepseek?.webSearch?.enabled === true,
    )
  const [modalities, setModalities] = useState<ChatModelModality[]>(() => {
    if (editableModel.modalities && editableModel.modalities.length > 0) {
      return [...editableModel.modalities]
    }
    return resolveDefaultChatModelModalities(selectedProvider)
  })
  const toggleModality = (modality: ChatModelModality) => {
    setModalities((prev) => {
      if (prev.includes(modality)) {
        if (prev.length === 1) return prev
        return prev.filter((m) => m !== modality)
      }
      return [...prev, modality]
    })
  }
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
  const enabledRequestParameterCount =
    Number(temperature !== undefined) +
    Number(topP !== undefined) +
    Number(maxOutputTokens !== undefined) +
    sanitizeCustomParameters(customParameters).filter(
      (entry) => !isReservedCustomParameterKey(entry.key),
    ).length

  const clearRequestParameterOverrides = () => {
    setTemperature(undefined)
    setTopP(undefined)
    setMaxOutputTokens(undefined)
    setCustomParameters([])
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
        const updatedModel: ChatModel = {
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

        updatedModel.reasoningType = reasoningType

        updatedModel.modalities =
          modalities.length > 0 ? Array.from(new Set(modalities)) : ['text']

        // Apply built-in (hosted) provider tools selection. The per-family
        // toggle objects are always written (even when the family isn't the
        // active one) so the user's prior choice persists across switches.
        updatedModel.builtinToolProvider = builtinToolProvider
        const trimmedMaxResults =
          openRouterWebSearchMaxResultsInput.trim().length > 0
            ? Number(openRouterWebSearchMaxResultsInput)
            : null
        const normalizedMaxResults =
          trimmedMaxResults !== null && Number.isFinite(trimmedMaxResults)
            ? Math.min(
                OPENROUTER_MAX_RESULTS_MAX,
                Math.max(
                  OPENROUTER_MAX_RESULTS_MIN,
                  Math.floor(trimmedMaxResults),
                ),
              )
            : undefined
        updatedModel.builtinTools = {
          gpt: { webSearch: { enabled: gptWebSearchEnabled } },
          openrouter: {
            webSearch: {
              enabled: openRouterWebSearchEnabled,
              ...(openRouterWebSearchEngine !== 'auto'
                ? { engine: openRouterWebSearchEngine }
                : {}),
              ...(normalizedMaxResults !== undefined
                ? { maxResults: normalizedMaxResults }
                : {}),
            },
          },
          grok: { webSearch: { enabled: grokWebSearchEnabled } },
          gemini: {
            webSearch: { enabled: geminiWebSearchEnabled },
            urlContext: { enabled: geminiUrlContextEnabled },
          },
          deepseek: { webSearch: { enabled: deepseekWebSearchEnabled } },
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
    <div className="yolo-chat-model-modal-form">
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
              setReasoningType(normalizeReasoningType(detected))
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
      <ObsidianSetting
        name={t('settings.models.reasoningType')}
        desc={t('settings.models.reasoningTypeDesc')}
      >
        <ObsidianDropdown
          value={reasoningType}
          options={{
            none: t('settings.models.reasoningTypeNone'),
            openai: t('settings.models.reasoningTypeOpenAI'),
            gemini: t('settings.models.reasoningTypeGemini'),
            anthropic: t('settings.models.reasoningTypeAnthropic'),
          }}
          onChange={(v: string) => {
            setReasoningType(normalizeReasoningType(v))
            setAutoDetectReasoning(false)
          }}
        />
      </ObsidianSetting>

      {/* Input modalities */}
      <div className="yolo-modality-field">
        <div className="yolo-modality-field-header">
          <div className="yolo-modality-field-label">
            {t('settings.models.inputModality')}
          </div>
          <div className="yolo-modality-field-desc">
            {t('settings.models.inputModalityDesc')}
          </div>
        </div>
        <div className="yolo-modality-chips">
          <button
            type="button"
            className={`yolo-modality-chip${
              modalities.includes('text') ? ' is-active' : ''
            }`}
            onClick={() => toggleModality('text')}
          >
            <Type size={14} />
            <span className="yolo-modality-chip-label">
              {t('settings.models.inputModalityText')}
            </span>
            <span className="yolo-modality-chip-sub">Text</span>
          </button>
          <button
            type="button"
            className={`yolo-modality-chip${
              modalities.includes('vision') ? ' is-active' : ''
            }`}
            data-tooltip={t('settings.models.inputModalityVisionTooltip')}
            onClick={() => toggleModality('vision')}
          >
            <ImageIcon size={14} />
            <span className="yolo-modality-chip-label">
              {t('settings.models.inputModalityVision')}
            </span>
            <span className="yolo-modality-chip-sub">Vision</span>
          </button>
          <button
            type="button"
            className={`yolo-modality-chip${
              modalities.includes('pdf') ? ' is-active' : ''
            }`}
            data-tooltip={t('settings.models.inputModalityPdfTooltip')}
            onClick={() => toggleModality('pdf')}
          >
            <FileText size={14} />
            <span className="yolo-modality-chip-label">
              {t('settings.models.inputModalityPdf')}
            </span>
            <span className="yolo-modality-chip-sub">PDF</span>
          </button>
        </div>
      </div>

      <ObsidianSetting
        name={t('settings.models.builtinToolProvider')}
        desc={t('settings.models.builtinToolProviderDesc')}
      >
        <ObsidianDropdown
          value={builtinToolProvider}
          options={
            selectedProvider?.presetType === 'openrouter'
              ? {
                  none: t('settings.models.builtinToolProviderNone'),
                  openrouter: t(
                    'settings.models.builtinToolProviderOpenRouter',
                  ),
                }
              : selectedProvider?.presetType === 'deepseek'
                ? {
                    none: t('settings.models.builtinToolProviderNone'),
                    deepseek: t('settings.models.builtinToolProviderDeepSeek'),
                  }
                : {
                    none: t('settings.models.builtinToolProviderNone'),
                    gemini: t('settings.models.builtinToolProviderGemini'),
                    gpt: t('settings.models.builtinToolProviderGpt'),
                    openrouter: t(
                      'settings.models.builtinToolProviderOpenRouter',
                    ),
                    grok: t('settings.models.builtinToolProviderGrok'),
                  }
          }
          onChange={(v: string) =>
            setBuiltinToolProvider(normalizeBuiltinToolProvider(v))
          }
        />
      </ObsidianSetting>

      {builtinToolProvider === 'gpt' && (
        <div className="yolo-agent-tools-panel yolo-agent-model-panel">
          <div className="yolo-agent-tools-panel-head yolo-agent-model-panel-head">
            <div className="yolo-agent-tools-panel-title">
              {t('settings.models.builtinToolsGpt')}
            </div>
          </div>

          <div className="yolo-agent-model-controls">
            <div className="yolo-agent-model-control">
              <div className="yolo-agent-model-control-top">
                <div className="yolo-agent-model-control-meta">
                  <div className="yolo-agent-model-control-label">
                    {t('settings.models.builtinToolWebSearch')}
                  </div>
                  <div className="yolo-agent-model-control-desc">
                    {t('settings.models.builtinToolWebSearchDesc')}
                  </div>
                </div>
                <div className="yolo-agent-model-control-actions">
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

      {builtinToolProvider === 'openrouter' && (
        <div className="yolo-agent-tools-panel yolo-agent-model-panel">
          <div className="yolo-agent-tools-panel-head yolo-agent-model-panel-head">
            <div className="yolo-agent-tools-panel-title">
              {t('settings.models.builtinToolsOpenRouter')}
            </div>
          </div>

          <div className="yolo-agent-model-controls">
            <div className="yolo-agent-model-control">
              <div className="yolo-agent-model-control-top">
                <div className="yolo-agent-model-control-meta">
                  <div className="yolo-agent-model-control-label">
                    {t('settings.models.builtinToolWebSearch')}
                  </div>
                  <div className="yolo-agent-model-control-desc">
                    {t('settings.models.builtinToolWebSearchDesc')}
                  </div>
                </div>
                <div className="yolo-agent-model-control-actions">
                  <ObsidianToggle
                    value={openRouterWebSearchEnabled}
                    onChange={setOpenRouterWebSearchEnabled}
                  />
                </div>
              </div>
            </div>

            {openRouterWebSearchEnabled && (
              <>
                <div className="yolo-agent-model-control">
                  <div className="yolo-agent-model-control-top">
                    <div className="yolo-agent-model-control-meta">
                      <div className="yolo-agent-model-control-label">
                        {t('settings.models.openRouterWebSearchEngine')}
                      </div>
                      <div className="yolo-agent-model-control-desc">
                        {t('settings.models.openRouterWebSearchEngineDesc')}
                      </div>
                    </div>
                    <div className="yolo-agent-model-control-actions">
                      <ObsidianDropdown
                        value={openRouterWebSearchEngine}
                        options={{
                          auto: t(
                            'settings.models.openRouterWebSearchEngineAuto',
                          ),
                          native: t(
                            'settings.models.openRouterWebSearchEngineNative',
                          ),
                          exa: t(
                            'settings.models.openRouterWebSearchEngineExa',
                          ),
                          firecrawl: t(
                            'settings.models.openRouterWebSearchEngineFirecrawl',
                          ),
                          parallel: t(
                            'settings.models.openRouterWebSearchEngineParallel',
                          ),
                        }}
                        onChange={(v: string) =>
                          setOpenRouterWebSearchEngine(
                            isOpenRouterWebSearchEngine(v) ? v : 'auto',
                          )
                        }
                      />
                    </div>
                  </div>
                </div>
                <div className="yolo-agent-model-control">
                  <div className="yolo-agent-model-control-top">
                    <div className="yolo-agent-model-control-meta">
                      <div className="yolo-agent-model-control-label">
                        {t('settings.models.openRouterWebSearchMaxResults')}
                      </div>
                      <div className="yolo-agent-model-control-desc">
                        {t('settings.models.openRouterWebSearchMaxResultsDesc')}
                      </div>
                    </div>
                    <div className="yolo-agent-model-control-actions">
                      <input
                        type="text"
                        inputMode="numeric"
                        className="yolo-agent-model-number"
                        placeholder={t(
                          'settings.models.openRouterWebSearchMaxResultsPlaceholder',
                        )}
                        value={openRouterWebSearchMaxResultsInput}
                        onChange={(event) => {
                          const next = event.currentTarget.value
                          if (!/^\d*$/.test(next)) return
                          setOpenRouterWebSearchMaxResultsInput(next)
                        }}
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {builtinToolProvider === 'grok' && (
        <div className="yolo-agent-tools-panel yolo-agent-model-panel">
          <div className="yolo-agent-tools-panel-head yolo-agent-model-panel-head">
            <div className="yolo-agent-tools-panel-title">
              {t('settings.models.builtinToolsGrok')}
            </div>
          </div>

          <div className="yolo-agent-model-controls">
            <div className="yolo-agent-model-control">
              <div className="yolo-agent-model-control-top">
                <div className="yolo-agent-model-control-meta">
                  <div className="yolo-agent-model-control-label">
                    {t('settings.models.builtinToolWebSearch')}
                  </div>
                  <div className="yolo-agent-model-control-desc">
                    {t('settings.models.builtinToolWebSearchDesc')}
                  </div>
                </div>
                <div className="yolo-agent-model-control-actions">
                  <ObsidianToggle
                    value={grokWebSearchEnabled}
                    onChange={setGrokWebSearchEnabled}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {builtinToolProvider === 'deepseek' && (
        <div className="yolo-agent-tools-panel yolo-agent-model-panel">
          <div className="yolo-agent-tools-panel-head yolo-agent-model-panel-head">
            <div className="yolo-agent-tools-panel-title">
              {t('settings.models.builtinToolsDeepSeek')}
            </div>
          </div>

          <div className="yolo-agent-model-controls">
            <div className="yolo-agent-model-control">
              <div className="yolo-agent-model-control-top">
                <div className="yolo-agent-model-control-meta">
                  <div className="yolo-agent-model-control-label">
                    {t('settings.models.builtinToolWebSearch')}
                  </div>
                  <div className="yolo-agent-model-control-desc">
                    {isDeepSeekWebSearchSupported
                      ? t('settings.models.builtinToolDeepSeekWebSearchDesc')
                      : t(
                          'settings.models.builtinToolDeepSeekWebSearchUnavailable',
                        )}
                  </div>
                </div>
                <div className="yolo-agent-model-control-actions">
                  <ObsidianToggle
                    value={
                      isDeepSeekWebSearchSupported && deepseekWebSearchEnabled
                    }
                    onChange={setDeepseekWebSearchEnabled}
                    disabled={!isDeepSeekWebSearchSupported}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {builtinToolProvider === 'gemini' && (
        <div className="yolo-agent-tools-panel yolo-agent-model-panel">
          <div className="yolo-agent-tools-panel-head yolo-agent-model-panel-head">
            <div className="yolo-agent-tools-panel-title">
              {t('settings.models.builtinToolsGemini')}
            </div>
          </div>

          <div className="yolo-agent-model-controls">
            <div className="yolo-agent-model-control">
              <div className="yolo-agent-model-control-top">
                <div className="yolo-agent-model-control-meta">
                  <div className="yolo-agent-model-control-label">
                    {t('settings.models.builtinToolWebSearch')}
                  </div>
                  <div className="yolo-agent-model-control-desc">
                    {t('settings.models.builtinToolWebSearchDesc')}
                  </div>
                </div>
                <div className="yolo-agent-model-control-actions">
                  <ObsidianToggle
                    value={geminiWebSearchEnabled}
                    onChange={setGeminiWebSearchEnabled}
                  />
                </div>
              </div>
            </div>
            <div className="yolo-agent-model-control">
              <div className="yolo-agent-model-control-top">
                <div className="yolo-agent-model-control-meta">
                  <div className="yolo-agent-model-control-label">
                    {t('settings.models.builtinToolUrlContext')}
                  </div>
                  <div className="yolo-agent-model-control-desc">
                    {t('settings.models.builtinToolUrlContextDesc')}
                  </div>
                </div>
                <div className="yolo-agent-model-control-actions">
                  <ObsidianToggle
                    value={geminiUrlContextEnabled}
                    onChange={setGeminiUrlContextEnabled}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="yolo-agent-model-context">
        <div className="yolo-agent-model-controls">
          <div
            className={`yolo-agent-model-control${
              maxContextTokens === undefined ? ' is-disabled' : ''
            }`}
          >
            <div className="yolo-agent-model-control-top">
              <div className="yolo-agent-model-control-meta">
                <div className="yolo-agent-model-control-label">
                  {t(
                    'settings.models.maxContextTokens',
                    'Context window tokens',
                  )}
                </div>
                <div className="yolo-agent-model-control-desc">
                  {t(
                    'settings.models.maxContextTokensDesc',
                    'Auto-filled when this model is recognized. Adjust it if your provider uses a different limit.',
                  )}
                </div>
              </div>
              <div className="yolo-agent-model-control-actions">
                <ObsidianToggle
                  value={maxContextTokens !== undefined}
                  onChange={setMaxContextTokensEnabled}
                />
              </div>
            </div>
            {maxContextTokens !== undefined && (
              <div className="yolo-agent-model-control-adjust">
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
                  className="yolo-agent-model-number"
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
        </div>
      </div>

      <ModelRequestParametersDisclosure
        enabledCount={enabledRequestParameterCount}
        onClear={clearRequestParameterOverrides}
      >
        <div className="yolo-agent-model-controls">
          <div
            className={`yolo-agent-model-control${
              temperature === undefined ? ' is-disabled' : ''
            }`}
          >
            <div className="yolo-agent-model-control-top">
              <div className="yolo-agent-model-control-meta">
                <div className="yolo-agent-model-control-label">
                  {t(
                    'settings.conversationSettings.temperature',
                    'Temperature',
                  )}
                </div>
              </div>
              <div className="yolo-agent-model-control-actions">
                <ObsidianToggle
                  value={temperature !== undefined}
                  onChange={setTemperatureEnabled}
                />
              </div>
            </div>
            {temperature !== undefined && (
              <div className="yolo-agent-model-control-adjust">
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
                  className="yolo-agent-model-number"
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
            className={`yolo-agent-model-control${
              topP === undefined ? ' is-disabled' : ''
            }`}
          >
            <div className="yolo-agent-model-control-top">
              <div className="yolo-agent-model-control-meta">
                <div className="yolo-agent-model-control-label">
                  {t('settings.conversationSettings.topP', 'Top P')}
                </div>
              </div>
              <div className="yolo-agent-model-control-actions">
                <ObsidianToggle
                  value={topP !== undefined}
                  onChange={setTopPEnabled}
                />
              </div>
            </div>
            {topP !== undefined && (
              <div className="yolo-agent-model-control-adjust">
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
                  className="yolo-agent-model-number"
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
            className={`yolo-agent-model-control${
              maxOutputTokens === undefined ? ' is-disabled' : ''
            }`}
          >
            <div className="yolo-agent-model-control-top">
              <div className="yolo-agent-model-control-meta">
                <div className="yolo-agent-model-control-label">
                  {t('settings.models.maxOutputTokens', 'Max output tokens')}
                </div>
              </div>
              <div className="yolo-agent-model-control-actions">
                <ObsidianToggle
                  value={maxOutputTokens !== undefined}
                  onChange={setMaxOutputTokensEnabled}
                />
              </div>
            </div>
            {maxOutputTokens !== undefined && (
              <div className="yolo-agent-model-control-adjust">
                <input
                  type="range"
                  min={256}
                  max={MAX_OUTPUT_TOKENS_SLIDER_MAX}
                  step={256}
                  value={Math.min(
                    MAX_OUTPUT_TOKENS_SLIDER_MAX,
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
                  className="yolo-agent-model-number"
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

        <ObsidianSetting
          name={t('settings.models.additionalParameters')}
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
            className="yolo-settings-kv-entry yolo-settings-kv-entry--inline"
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
              placeholder={t(
                'settings.models.customParametersValuePlaceholder',
              )}
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
      </ModelRequestParametersDisclosure>

      <ObsidianSetting>
        <ObsidianButton text={t('common.save')} onClick={handleSubmit} cta />
        <ObsidianButton text={t('common.cancel')} onClick={onClose} />
      </ObsidianSetting>
    </div>
  )
}
