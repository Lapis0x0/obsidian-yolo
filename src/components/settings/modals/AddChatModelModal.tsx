import { GoogleGenAI } from '@google/genai'
import { App, Notice, requestUrl } from 'obsidian'
import { useEffect, useState } from 'react'

import { DEFAULT_PROVIDERS } from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import SmartComposerPlugin from '../../../main'
import { ChatModel, chatModelSchema } from '../../../types/chat-model.types'
import { LLMProvider } from '../../../types/provider.types'
import {
  detectReasoningTypeFromModelId,
  ensureUniqueModelId,
  generateModelId,
} from '../../../utils/model-id-utils'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ReactModal } from '../../common/ReactModal'
import { SearchableDropdown } from '../../common/SearchableDropdown'

type AddChatModelModalComponentProps = {
  plugin: SmartComposerPlugin
  provider?: LLMProvider
}

const MODEL_IDENTIFIER_KEYS = ['id', 'name', 'model'] as const

const REASONING_TYPES = [
  'none',
  'openai',
  'gemini',
  'anthropic',
  'generic',
  'base',
] as const
type ReasoningType = (typeof REASONING_TYPES)[number]

const GEMINI_TOOL_TYPES = ['none', 'gemini'] as const

const REASONING_CONFIG_PROVIDER_TYPES = [
  'openai',
  'openrouter',
  'openai-compatible',
] as const
const THINKING_CONFIG_PROVIDER_TYPES = [
  'anthropic',
  'gemini',
  'openrouter',
  'openai-compatible',
] as const

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

const isReasoningType = (value: string): value is ReasoningType =>
  REASONING_TYPES.includes(value as ReasoningType)

const isGeminiToolType = (
  value: string,
): value is (typeof GEMINI_TOOL_TYPES)[number] =>
  GEMINI_TOOL_TYPES.includes(value as (typeof GEMINI_TOOL_TYPES)[number])

type ReasoningConfigurableModel = Extract<
  ChatModel,
  { providerType: 'openai' | 'openrouter' | 'openai-compatible' }
>
type ThinkingConfigurableModel = Extract<
  ChatModel,
  {
    providerType: 'anthropic' | 'gemini' | 'openrouter' | 'openai-compatible'
  }
>

const isReasoningConfigurable = (
  model: ChatModel,
): model is ReasoningConfigurableModel =>
  (REASONING_CONFIG_PROVIDER_TYPES as readonly string[]).includes(
    model.providerType,
  )

const isThinkingConfigurable = (
  model: ChatModel,
): model is ThinkingConfigurableModel =>
  (THINKING_CONFIG_PROVIDER_TYPES as readonly string[]).includes(
    model.providerType,
  )

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
  const initialProviderId = selectedProvider?.id ?? DEFAULT_PROVIDERS[0].id
  const initialProviderType =
    selectedProvider?.type ?? DEFAULT_PROVIDERS[0].type
  const [formData, setFormData] = useState<ChatModel>({
    providerId: initialProviderId,
    providerType: initialProviderType,
    id: '',
    model: '',
    name: undefined,
  })

  // Auto-fetch available models via OpenAI-compatible GET /v1/models
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState<boolean>(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Reasoning type selection: none | openai | gemini | anthropic | generic | base
  const [reasoningType, setReasoningType] = useState<ReasoningType>('none')
  // When user manually changes reasoning type, stop auto-detection
  const [autoDetectReasoning, setAutoDetectReasoning] = useState<boolean>(true)
  // Tool type (only meaningful for Gemini provider)
  const [toolType, setToolType] =
    useState<(typeof GEMINI_TOOL_TYPES)[number]>('none')
  const defaultSamplingCustomParameters: { key: string; value: string }[] = [
    { key: 'temperature', value: '0.8' },
    { key: 'top_p', value: '' },
  ]
  const [customParameters, setCustomParameters] = useState<
    { key: string; value: string }[]
  >([...defaultSamplingCustomParameters])

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
        const isOpenAIStyle =
          selectedProvider.type === 'openai' ||
          selectedProvider.type === 'openai-compatible' ||
          selectedProvider.type === 'openrouter' ||
          selectedProvider.type === 'groq' ||
          selectedProvider.type === 'mistral' ||
          selectedProvider.type === 'perplexity' ||
          selectedProvider.type === 'deepseek'

        if (isOpenAIStyle) {
          const base = ((): string => {
            // default OpenAI base when not provided
            const cleaned = selectedProvider.baseUrl?.replace(/\/+$/, '')
            if (cleaned && cleaned.length > 0) return cleaned
            if (selectedProvider.type === 'openai')
              return 'https://api.openai.com/v1'
            if (selectedProvider.type === 'openrouter')
              return 'https://openrouter.ai/api/v1'
            return '' // no base => skip
          })()

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

        if (selectedProvider.type === 'gemini') {
          const baseUrl = normalizeGeminiBaseUrl(selectedProvider.baseUrl)
          const ai = new GoogleGenAI({
            apiKey: selectedProvider.apiKey ?? '',
            httpOptions: baseUrl ? { baseUrl } : undefined,
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
    const sanitizedCustomParameters = customParameters
      .map((entry) => ({ key: entry.key.trim(), value: entry.value }))
      .filter((entry) => entry.key.length > 0)

    let modelDataWithPrefix: ChatModel = {
      ...formData,
      id: modelIdWithPrefix,
      name:
        formData.name && formData.name.trim().length > 0
          ? formData.name
          : formData.model,
      // Persist tool type when provider is Gemini; keep optional otherwise
      ...(selectedProvider?.type === 'gemini' ? { toolType } : {}),
      ...(sanitizedCustomParameters.length > 0
        ? { customParameters: sanitizedCustomParameters }
        : {}),
    }

    if (reasoningType === 'base') {
      modelDataWithPrefix = {
        ...modelDataWithPrefix,
        isBaseModel: true,
        reasoningType: undefined,
      }
    } else {
      const withoutBaseFlag = Object.fromEntries(
        Object.entries(modelDataWithPrefix as Record<string, unknown>).filter(
          ([key]) => key !== 'isBaseModel',
        ),
      ) as ChatModel
      modelDataWithPrefix = {
        ...withoutBaseFlag,
        reasoningType: reasoningType === 'none' ? 'none' : reasoningType,
      }

      if (
        reasoningType === 'openai' &&
        !isReasoningConfigurable(modelDataWithPrefix)
      ) {
        new Notice(t('common.error'))
        return
      }
      if (
        (reasoningType === 'gemini' || reasoningType === 'anthropic') &&
        !isThinkingConfigurable(modelDataWithPrefix)
      ) {
        new Notice(t('common.error'))
        return
      }
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
    <>
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
            base: t('settings.models.reasoningTypeBase'),
          }}
          onChange={(value: string) => {
            setReasoningType(
              isReasoningType(value) ? value : REASONING_TYPES[0],
            )
            setAutoDetectReasoning(false)
          }}
        />
      </ObsidianSetting>

      {reasoningType === 'base' && (
        <div className="smtcmp-settings-desc">
          {t('settings.models.baseModelWarning')}
        </div>
      )}

      {/* Reasoning strength is controlled in the chat sidebar */}
      {/* Tool type for Gemini provider */}
      {selectedProvider?.type === 'gemini' && (
        <ObsidianSetting
          name={t('settings.models.toolType')}
          desc={t('settings.models.toolTypeDesc')}
        >
          <ObsidianDropdown
            value={toolType}
            options={{
              none: t('settings.models.toolTypeNone'),
              gemini: t('settings.models.toolTypeGemini'),
            }}
            onChange={(value: string) =>
              setToolType(
                isGeminiToolType(value) ? value : GEMINI_TOOL_TYPES[0],
              )
            }
          />
        </ObsidianSetting>
      )}

      {/* Provider is derived from the current group context; field removed intentionally */}

      <ObsidianSetting
        name={t('settings.models.customParameters')}
        desc={t('settings.models.customParametersDesc')}
      >
        <ObsidianButton
          text={t('settings.models.customParametersAdd')}
          onClick={() =>
            setCustomParameters((prev) => [...prev, { key: '', value: '' }])
          }
        />
      </ObsidianSetting>

      {customParameters.map((param, index) => (
        <ObsidianSetting
          key={`custom-parameter-${index}`}
          className="smtcmp-settings-kv-entry"
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
    </>
  )
}
