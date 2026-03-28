import { GoogleGenAI } from '@google/genai'
import { App, Notice, requestUrl } from 'obsidian'
import { useEffect, useRef, useState } from 'react'

import { DEFAULT_CHAT_MODELS } from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import SmartComposerPlugin from '../../../main'
import { ChatModel, chatModelSchema } from '../../../types/chat-model.types'
import { CustomParameter } from '../../../types/custom-parameter.types'
import { LLMProvider } from '../../../types/provider.types'
import {
  normalizeCustomParameterType,
  sanitizeCustomParameters,
} from '../../../utils/custom-parameters'
import { resolveProviderBaseUrl } from '../../../utils/llm/provider-base-url'
import { toProviderHeadersRecord } from '../../../utils/llm/provider-headers'
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
import { SearchableDropdown } from '../../common/SearchableDropdown'

type AddChatModelModalComponentProps = {
  plugin: SmartComposerPlugin
  provider?: LLMProvider
}

type CustomParameterFormEntry = CustomParameter & {
  uid: string
}

const MODEL_IDENTIFIER_KEYS = ['id', 'name', 'model'] as const

const REASONING_TYPES = [
  'none',
  'openai',
  'gemini',
  'anthropic',
  'generic',
] as const
type ReasoningType = (typeof REASONING_TYPES)[number]

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
  maxOutputTokens: 4096,
} as const

const clampTemperature = (value: number): number =>
  Math.min(2, Math.max(0, value))

const clampTopP = (value: number): number => Math.min(1, Math.max(0, value))

const clampMaxOutputTokens = (value: number): number =>
  Math.max(1, Math.floor(value))

const extractModelIdentifier = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value
  }
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  for (const key of MODEL_IDENTIFIER_KEYS) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate
    }
  }
  return null
}

const collectModelIdentifiers = (values: unknown[]): string[] =>
  values
    .map((entry) => extractModelIdentifier(entry))
    .filter((id): id is string => Boolean(id))

const normalizeGeminiBaseUrl = (raw?: string): string | undefined => {
  if (!raw) return undefined
  const trimmed = raw.replace(/\/+$/, '')
  try {
    const url = new URL(trimmed)
    // Strip trailing version segments to avoid double-appending by SDK
    url.pathname = url.pathname.replace(/\/?(v1beta|v1alpha1|v1)(\/)?$/, '')
    return url.toString().replace(/\/+$/, '')
  } catch {
    return trimmed.replace(/\/?(v1beta|v1alpha1|v1)(\/)?$/, '')
  }
}

const CHATGPT_OAUTH_DEFAULT_MODELS = Array.from(
  new Set([
    ...DEFAULT_CHAT_MODELS.filter((model) =>
      model.providerId.startsWith('chatgpt-oauth'),
    ).map((model) => model.model),
    'gpt-5.1-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5.2',
    'gpt-5.2-codex',
  ]),
)

const isReasoningType = (value: string): value is ReasoningType =>
  REASONING_TYPES.includes(value as ReasoningType)

const isToolType = (value: string): value is ToolType =>
  TOOL_TYPES.includes(value as ToolType)

const isReasoningConfigurable = (
  provider: LLMProvider | undefined,
): provider is LLMProvider =>
  provider?.apiType === 'openai-compatible' ||
  provider?.apiType === 'openai-responses'

const isThinkingConfigurable = (
  provider: LLMProvider | undefined,
): provider is LLMProvider =>
  provider?.apiType === 'anthropic' ||
  provider?.apiType === 'gemini' ||
  provider?.apiType === 'openai-compatible' ||
  provider?.apiType === 'amazon-bedrock'

const supportsGeminiTools = (provider: LLMProvider | undefined): boolean =>
  provider?.apiType === 'gemini' || provider?.apiType === 'openai-compatible'

const supportsGptTools = (provider: LLMProvider | undefined): boolean =>
  provider?.apiType === 'openai-compatible' ||
  provider?.apiType === 'openai-responses'

export class AddChatModelModal extends ReactModal<AddChatModelModalComponentProps> {
  constructor(app: App, plugin: SmartComposerPlugin, provider?: LLMProvider) {
    super({
      app: app,
      Component: AddChatModelModalComponent,
      props: { plugin, provider },
      options: {
        title: 'Add custom chat model', // Will be translated in component
      },
      plugin: plugin,
    })
  }
}

function AddChatModelModalComponent({
  plugin,
  onClose,
  provider,
}: AddChatModelModalComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const selectedProvider: LLMProvider | undefined =
    provider ?? plugin.settings.providers[0]
  const initialProviderId = selectedProvider?.id ?? ''
  const [formData, setFormData] = useState<ChatModel>({
    providerId: initialProviderId,
    id: '',
    model: '',
    name: undefined,
    temperature: undefined,
    topP: undefined,
    maxOutputTokens: undefined,
  })

  // Auto-fetch available models via OpenAI-compatible GET /v1/models
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState<boolean>(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Reasoning type selection: none | openai | gemini | anthropic | generic
  const [reasoningType, setReasoningType] = useState<ReasoningType>('none')
  // When user manually changes reasoning type, stop auto-detection
  const [autoDetectReasoning, setAutoDetectReasoning] = useState<boolean>(true)
  const [toolType, setToolType] = useState<ToolType>('none')
  const [gptWebSearchEnabled, setGptWebSearchEnabled] = useState<boolean>(false)
  const [modelParamCache, setModelParamCache] = useState<{
    temperature: number
    topP: number
    maxOutputTokens: number
  }>(() => ({
    temperature: MODEL_SAMPLING_DEFAULTS.temperature,
    topP: MODEL_SAMPLING_DEFAULTS.topP,
    maxOutputTokens: MODEL_SAMPLING_DEFAULTS.maxOutputTokens,
  }))
  const customParameterUidRef = useRef(0)
  const createCustomParameterUid = (): string => {
    customParameterUidRef.current += 1
    return `custom-param-${customParameterUidRef.current}`
  }
  const [customParameters, setCustomParameters] = useState<
    CustomParameterFormEntry[]
  >([])

  useEffect(() => {
    const fetchModels = async () => {
      if (!selectedProvider) {
        setAvailableModels([])
        setLoadingModels(false)
        return
      }

      // Check cache first
      const cachedModels = plugin.getCachedModelList(selectedProvider.id)
      if (cachedModels) {
        setAvailableModels(cachedModels)
        setLoadingModels(false)
        return
      }

      setLoadingModels(true)
      setLoadError(null)
      try {
        const providerHeaders = toProviderHeadersRecord(
          selectedProvider.customHeaders,
        )
        const isOpenAIStyle =
          selectedProvider.apiType === 'openai-compatible' ||
          selectedProvider.apiType === 'openai-responses'

        if (selectedProvider.presetType === 'chatgpt-oauth') {
          const service = plugin.getChatGPTOAuthService(selectedProvider.id)
          const credential = await service.getUsableCredential()

          if (!credential) {
            const fallback = Array.from(
              new Set(CHATGPT_OAUTH_DEFAULT_MODELS),
            ).sort()
            setAvailableModels(fallback)
            plugin.setCachedModelList(selectedProvider.id, fallback)
            return
          }

          const base = (
            selectedProvider.baseUrl?.trim() ||
            'https://chatgpt.com/backend-api/codex'
          ).replace(/\/+$/, '')
          const baseWithoutVersion = base.replace(/\/v\d+$/, '')
          const urlCandidates = Array.from(
            new Set([
              `${base}/models`,
              `${baseWithoutVersion}/models`,
              `${base}/responses/models`,
              `${baseWithoutVersion}/responses/models`,
            ]),
          )

          let lastErr: unknown = null
          for (const url of urlCandidates) {
            try {
              const response = await requestUrl({
                url,
                method: 'GET',
                headers: {
                  Accept: 'application/json',
                  Authorization: `Bearer ${credential.accessToken}`,
                  originator: 'opencode',
                  ...(credential.accountId
                    ? { 'ChatGPT-Account-Id': credential.accountId }
                    : {}),
                  ...(providerHeaders ?? {}),
                },
              })
              if (response.status < 200 || response.status >= 300) {
                lastErr = new Error(
                  `Failed to fetch models: ${response.status}`,
                )
                continue
              }
              const json = response.json ?? JSON.parse(response.text)
              const buckets: string[] = []
              if (Array.isArray(json?.data)) {
                buckets.push(...collectModelIdentifiers(json.data))
              }
              if (Array.isArray(json?.models)) {
                buckets.push(...collectModelIdentifiers(json.models))
              }
              if (Array.isArray(json)) {
                buckets.push(...collectModelIdentifiers(json))
              }

              const unique = Array.from(
                new Set([...buckets, ...CHATGPT_OAUTH_DEFAULT_MODELS]),
              ).sort()
              if (unique.length === 0) {
                lastErr = new Error('Empty models list in response')
                continue
              }

              setAvailableModels(unique)
              plugin.setCachedModelList(selectedProvider.id, unique)
              return
            } catch (error) {
              lastErr = error
            }
          }

          console.warn(
            '[YOLO] Failed to fetch ChatGPT OAuth models, fallback to defaults.',
            lastErr,
          )
          const fallback = Array.from(
            new Set(CHATGPT_OAUTH_DEFAULT_MODELS),
          ).sort()
          setAvailableModels(fallback)
          plugin.setCachedModelList(selectedProvider.id, fallback)
          return
        }

        if (isOpenAIStyle) {
          const base = resolveProviderBaseUrl(selectedProvider) ?? ''

          if (base) {
            const baseNorm = base.replace(/\/+$/, '')
            const urlCandidates: string[] = []
            if (baseNorm.endsWith('/v1')) {
              // Try with v1 first, then without v1
              urlCandidates.push(`${baseNorm}/models`)
              urlCandidates.push(`${baseNorm.replace(/\/v1$/, '')}/models`)
            } else {
              // Try without v1 first, then with v1
              urlCandidates.push(`${baseNorm}/models`)
              urlCandidates.push(`${baseNorm}/v1/models`)
            }

            let fetched = false
            let lastErr: unknown = null
            for (const url of urlCandidates) {
              try {
                const response = await requestUrl({
                  url,
                  method: 'GET',
                  headers: {
                    ...(selectedProvider.apiKey
                      ? { Authorization: `Bearer ${selectedProvider.apiKey}` }
                      : {}),
                    Accept: 'application/json',
                    ...(providerHeaders ?? {}),
                  },
                })
                if (response.status < 200 || response.status >= 300) {
                  lastErr = new Error(
                    `Failed to fetch models: ${response.status}`,
                  )
                  continue
                }
                const json = response.json ?? JSON.parse(response.text)
                // Robust extraction: support data[], models[], or array root; prefer id, fallback to name/model
                const collectFrom = (arr: unknown[]): string[] =>
                  collectModelIdentifiers(arr)

                const buckets: string[] = []
                if (Array.isArray(json?.data))
                  buckets.push(...collectFrom(json.data))
                if (Array.isArray(json?.models))
                  buckets.push(...collectFrom(json.models))
                if (Array.isArray(json)) buckets.push(...collectFrom(json))

                if (buckets.length === 0) {
                  lastErr = new Error('Empty models list in response')
                  continue
                }
                const unique = Array.from(new Set(buckets)).sort()
                setAvailableModels(unique)
                // Cache the result
                plugin.setCachedModelList(selectedProvider.id, unique)
                fetched = true
                break
              } catch (error) {
                lastErr = error
                continue
              }
            }
            if (fetched) return
            if (lastErr instanceof Error) {
              throw lastErr
            }
            throw new Error('Failed to fetch models from all endpoints')
          }
        }

        if (selectedProvider.apiType === 'gemini') {
          const baseUrl = normalizeGeminiBaseUrl(selectedProvider.baseUrl)
          const ai = new GoogleGenAI({
            apiKey: selectedProvider.apiKey ?? '',
            httpOptions:
              baseUrl || providerHeaders
                ? {
                    ...(baseUrl ? { baseUrl } : {}),
                    ...(providerHeaders ? { headers: providerHeaders } : {}),
                  }
                : undefined,
          })
          const pager = await ai.models.list()
          const names: string[] = []
          for await (const entry of pager) {
            const raw = extractModelIdentifier(entry) ?? ''
            if (!raw) continue
            // Normalize like "models/gemini-2.5-pro" -> "gemini-2.5-pro"
            const norm = raw.includes('/') ? raw.split('/').pop()! : raw
            // Only keep gemini text/chat models
            if (norm.toLowerCase().includes('gemini')) names.push(norm)
          }
          // De-dup and sort for UX
          const unique = Array.from(new Set(names)).sort()
          setAvailableModels(unique)
          // Cache the result
          plugin.setCachedModelList(selectedProvider.id, unique)
          return
        }
      } catch (err: unknown) {
        console.error('Failed to auto fetch models', err)
        const errorMessage =
          err instanceof Error ? err.message : 'unknown error'
        setLoadError(errorMessage)
      } finally {
        setLoadingModels(false)
      }
    }

    void fetchModels()
  }, [plugin, selectedProvider])

  const resetModelParams = () => {
    setModelParamCache({
      temperature: MODEL_SAMPLING_DEFAULTS.temperature,
      topP: MODEL_SAMPLING_DEFAULTS.topP,
      maxOutputTokens: MODEL_SAMPLING_DEFAULTS.maxOutputTokens,
    })
    setFormData((prev) => ({
      ...prev,
      temperature: MODEL_SAMPLING_DEFAULTS.temperature,
      topP: MODEL_SAMPLING_DEFAULTS.topP,
      maxOutputTokens: MODEL_SAMPLING_DEFAULTS.maxOutputTokens,
    }))
  }

  const setTemperatureEnabled = (enabled: boolean) => {
    setFormData((prev) => {
      const current = prev.temperature ?? modelParamCache.temperature
      setModelParamCache((cache) => ({ ...cache, temperature: current }))
      return { ...prev, temperature: enabled ? current : undefined }
    })
  }

  const setTopPEnabled = (enabled: boolean) => {
    setFormData((prev) => {
      const current = prev.topP ?? modelParamCache.topP
      setModelParamCache((cache) => ({ ...cache, topP: current }))
      return { ...prev, topP: enabled ? current : undefined }
    })
  }

  const setMaxOutputTokensEnabled = (enabled: boolean) => {
    setFormData((prev) => {
      const current = prev.maxOutputTokens ?? modelParamCache.maxOutputTokens
      setModelParamCache((cache) => ({ ...cache, maxOutputTokens: current }))
      return { ...prev, maxOutputTokens: enabled ? current : undefined }
    })
  }

  const handleSubmit = () => {
    // Validate required API model id
    if (!formData.model || formData.model.trim().length === 0) {
      new Notice(t('common.error'))
      return
    }

    // Generate internal id (provider/model) and ensure uniqueness by suffix if needed
    const baseInternalId = generateModelId(formData.providerId, formData.model)
    const existingIds = plugin.settings.chatModels.map((m) => m.id)
    const modelIdWithPrefix = ensureUniqueModelId(existingIds, baseInternalId)
    const sanitizedCustomParameters = sanitizeCustomParameters(
      customParameters,
    ).filter((entry) => !isReservedCustomParameterKey(entry.key))

    let modelDataWithPrefix: ChatModel = {
      ...formData,
      id: modelIdWithPrefix,
      name:
        formData.name && formData.name.trim().length > 0
          ? formData.name
          : formData.model,
      ...(supportsGeminiTools(selectedProvider) ||
      supportsGptTools(selectedProvider)
        ? { toolType }
        : {}),
      gptTools: {
        webSearch: {
          enabled: gptWebSearchEnabled,
        },
      },
      ...(sanitizedCustomParameters.length > 0
        ? { customParameters: sanitizedCustomParameters }
        : {}),
    }

    modelDataWithPrefix = {
      ...modelDataWithPrefix,
      reasoningType: reasoningType === 'none' ? 'none' : reasoningType,
    }

    if (
      reasoningType === 'openai' &&
      !isReasoningConfigurable(selectedProvider)
    ) {
      new Notice(t('common.error'))
      return
    }
    if (
      (reasoningType === 'gemini' || reasoningType === 'anthropic') &&
      !isThinkingConfigurable(selectedProvider)
    ) {
      new Notice(t('common.error'))
      return
    }

    // Allow duplicates of the same calling ID by uniquifying internal id; no blocking here

    if (
      !plugin.settings.providers.some(
        (provider) => provider.id === formData.providerId,
      )
    ) {
      new Notice('Provider with this ID does not exist')
      return
    }

    const validationResult = chatModelSchema.safeParse(modelDataWithPrefix)
    if (!validationResult.success) {
      new Notice(validationResult.error.issues.map((v) => v.message).join('\n'))
      return
    }

    void plugin
      .setSettings({
        ...plugin.settings,
        chatModels: [...plugin.settings.chatModels, modelDataWithPrefix],
      })
      .then(() => {
        onClose()
      })
      .catch((error) => {
        console.error('Failed to add chat model', error)
        new Notice(t('common.error'))
      })
  }

  return (
    <div className="smtcmp-chat-model-modal-form">
      {/* Available models dropdown (moved above modelId) */}
      <ObsidianSetting
        name={
          loadingModels
            ? t('common.loading')
            : t('settings.models.availableModelsAuto')
        }
        desc={
          loadError
            ? `${t('settings.models.fetchModelsFailed')}：${loadError}`
            : undefined
        }
      >
        <SearchableDropdown
          value={formData.model || ''}
          options={availableModels}
          onChange={(value: string) => {
            // When a model is selected, set API model id and also update display name
            setFormData((prev) => ({
              ...prev,
              model: value,
              name: value, // Always update display name with the selected model
            }))
            if (autoDetectReasoning) {
              const detected = detectReasoningTypeFromModelId(value)
              setReasoningType(detected)
            }
          }}
          disabled={loadingModels || availableModels.length === 0}
          loading={loadingModels}
          placeholder={t('settings.models.searchModels') || 'Search models...'}
        />
      </ObsidianSetting>

      {/* Model calling ID */}
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

      {/* Display name (moved right below modelId) */}
      <ObsidianSetting name={t('settings.models.modelName')}>
        <ObsidianTextInput
          value={formData.name ?? ''}
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
          onChange={(value: string) => {
            setReasoningType(
              isReasoningType(value) ? value : REASONING_TYPES[0],
            )
            setAutoDetectReasoning(false)
          }}
        />
      </ObsidianSetting>

      {/* Reasoning strength is controlled in the chat sidebar */}
      {/* Tool type for Gemini provider */}
      {(supportsGeminiTools(selectedProvider) ||
        supportsGptTools(selectedProvider)) && (
        <ObsidianSetting
          name={t('settings.models.toolType')}
          desc={t('settings.models.toolTypeDesc')}
        >
          <ObsidianDropdown
            value={toolType}
            options={Object.fromEntries(
              [
                ['none', t('settings.models.toolTypeNone')],
                supportsGeminiTools(selectedProvider)
                  ? ['gemini', t('settings.models.toolTypeGemini')]
                  : null,
                supportsGptTools(selectedProvider)
                  ? ['gpt', t('settings.models.toolTypeGpt')]
                  : null,
              ].filter((entry): entry is [string, string] => entry !== null),
            )}
            onChange={(value: string) =>
              setToolType(isToolType(value) ? value : TOOL_TYPES[0])
            }
          />
        </ObsidianSetting>
      )}

      {toolType === 'gpt' && supportsGptTools(selectedProvider) && (
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

      {/* Provider is derived from the current group context; field removed intentionally */}

      <div className="smtcmp-agent-tools-panel smtcmp-agent-model-panel">
        <div className="smtcmp-agent-tools-panel-head smtcmp-agent-model-panel-head">
          <div className="smtcmp-agent-tools-panel-title">
            {t('settings.models.sampling', 'Sampling parameters')}
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
              formData.temperature === undefined ? ' is-disabled' : ''
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
                  value={formData.temperature !== undefined}
                  onChange={setTemperatureEnabled}
                />
              </div>
            </div>
            {formData.temperature !== undefined && (
              <div className="smtcmp-agent-model-control-adjust">
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={formData.temperature ?? modelParamCache.temperature}
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
                    setFormData((prev) => ({ ...prev, temperature: clamped }))
                  }}
                />
                <input
                  type="number"
                  className="smtcmp-agent-model-number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={formData.temperature ?? modelParamCache.temperature}
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
                    setFormData((prev) => ({ ...prev, temperature: clamped }))
                  }}
                />
              </div>
            )}
          </div>

          <div
            className={`smtcmp-agent-model-control${
              formData.topP === undefined ? ' is-disabled' : ''
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
                  value={formData.topP !== undefined}
                  onChange={setTopPEnabled}
                />
              </div>
            </div>
            {formData.topP !== undefined && (
              <div className="smtcmp-agent-model-control-adjust">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={formData.topP ?? modelParamCache.topP}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value)
                    if (!Number.isFinite(next)) {
                      return
                    }
                    const clamped = clampTopP(next)
                    setModelParamCache((prev) => ({ ...prev, topP: clamped }))
                    setFormData((prev) => ({ ...prev, topP: clamped }))
                  }}
                />
                <input
                  type="number"
                  className="smtcmp-agent-model-number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={formData.topP ?? modelParamCache.topP}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value)
                    if (!Number.isFinite(next)) {
                      return
                    }
                    const clamped = clampTopP(next)
                    setModelParamCache((prev) => ({ ...prev, topP: clamped }))
                    setFormData((prev) => ({ ...prev, topP: clamped }))
                  }}
                />
              </div>
            )}
          </div>

          <div
            className={`smtcmp-agent-model-control${
              formData.maxOutputTokens === undefined ? ' is-disabled' : ''
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
                  value={formData.maxOutputTokens !== undefined}
                  onChange={setMaxOutputTokensEnabled}
                />
              </div>
            </div>
            {formData.maxOutputTokens !== undefined && (
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
                      formData.maxOutputTokens ??
                        modelParamCache.maxOutputTokens,
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
                    setFormData((prev) => ({
                      ...prev,
                      maxOutputTokens: clamped,
                    }))
                  }}
                />
                <input
                  type="number"
                  className="smtcmp-agent-model-number"
                  min={1}
                  step={1}
                  value={
                    formData.maxOutputTokens ?? modelParamCache.maxOutputTokens
                  }
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
                    setFormData((prev) => ({
                      ...prev,
                      maxOutputTokens: clamped,
                    }))
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
        <ObsidianButton text={t('common.add')} onClick={handleSubmit} cta />
        <ObsidianButton text={t('common.cancel')} onClick={onClose} />
      </ObsidianSetting>
    </div>
  )
}
