import { GoogleGenAI } from '@google/genai'
import {
  Check,
  FileText,
  Image as ImageIcon,
  Layers,
  Square,
  Type,
} from 'lucide-react'
import { App, Notice, requestUrl } from 'obsidian'
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'

import { DEFAULT_CHAT_MODELS } from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import { listBedrockChatModelIds } from '../../../core/llm/bedrockCatalog'
import YoloPlugin from '../../../main'
import {
  ChatModel,
  ChatModelModality,
  chatModelSchema,
} from '../../../types/chat-model.types'
import { CustomParameter } from '../../../types/custom-parameter.types'
import { LLMProvider } from '../../../types/provider.types'
import {
  normalizeCustomParameterType,
  sanitizeCustomParameters,
} from '../../../utils/custom-parameters'
import { formatIntegerWithGrouping } from '../../../utils/formatIntegerWithGrouping'
import {
  resolveKnownChatModelModalities,
  resolveKnownMaxContextTokens,
} from '../../../utils/llm/model-capability-registry'
import { resolveDefaultChatModelModalities } from '../../../utils/llm/model-modalities'
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
  plugin: YoloPlugin
  provider?: LLMProvider
}

type CustomParameterFormEntry = CustomParameter & {
  uid: string
}

const MODEL_IDENTIFIER_KEYS = ['id', 'name', 'model'] as const

const REASONING_TYPES = ['none', 'openai', 'gemini', 'anthropic'] as const
type ReasoningType = (typeof REASONING_TYPES)[number]

const BUILTIN_TOOL_PROVIDERS = [
  'none',
  'gemini',
  'gpt',
  'openrouter',
  'grok',
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

const GEMINI_OAUTH_DEFAULT_MODELS = Array.from(
  new Set([
    ...DEFAULT_CHAT_MODELS.filter((model) =>
      model.providerId.startsWith('gemini-oauth'),
    ).map((model) => model.model),
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
  ]),
)

const QWEN_OAUTH_DEFAULT_MODELS = Array.from(
  new Set([
    ...DEFAULT_CHAT_MODELS.filter((model) =>
      model.providerId.startsWith('qwen-oauth'),
    ).map((model) => model.model),
    'coder-model',
  ]),
)

const isReasoningType = (value: string): value is ReasoningType =>
  REASONING_TYPES.includes(value as ReasoningType)

const isBuiltinToolProvider = (value: string): value is BuiltinToolProvider =>
  BUILTIN_TOOL_PROVIDERS.includes(value as BuiltinToolProvider)

const isReasoningTypeCompatible = (
  provider: LLMProvider | undefined,
  reasoningType: ReasoningType,
): boolean => {
  if (!provider) return false
  switch (reasoningType) {
    case 'none':
      return true
    case 'openai':
      return (
        provider.apiType === 'openai-responses' ||
        provider.apiType === 'openai-compatible'
      )
    case 'gemini':
      return (
        provider.apiType === 'gemini' ||
        provider.apiType === 'openai-compatible'
      )
    case 'anthropic':
      return (
        provider.apiType === 'anthropic' ||
        provider.apiType === 'openai-compatible' ||
        provider.apiType === 'amazon-bedrock'
      )
  }
}

// Provider–family alignment is the user's responsibility (per upstream
// request): every family is selectable on every model, and downstream provider
// clients only forward families they understand. Picking a family on a
// gateway that doesn't support it is silently a no-op rather than an error.

export class AddChatModelModal extends ReactModal<AddChatModelModalComponentProps> {
  constructor(app: App, plugin: YoloPlugin, provider?: LLMProvider) {
    super({
      app: app,
      Component: AddChatModelModalComponent,
      props: { plugin, provider },
      // No native title: the component renders its own header so the
      // single/batch switcher can share the title's row (native title bar is
      // hidden via the className below).
      options: {
        className: 'yolo-add-chat-model-modal',
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
    maxContextTokens: undefined,
    maxOutputTokens: undefined,
  })
  const [maxContextTokensInput, setMaxContextTokensInput] = useState<string>('')
  const [isMaxContextTokensInputFocused, setIsMaxContextTokensInputFocused] =
    useState(false)

  // Auto-fetch available models via OpenAI-compatible GET /v1/models
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState<boolean>(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reasoningType, setReasoningType] = useState<ReasoningType>('none')
  // When user manually changes reasoning type, stop auto-detection
  const [autoDetectReasoning, setAutoDetectReasoning] = useState<boolean>(true)
  const [builtinToolProvider, setBuiltinToolProvider] =
    useState<BuiltinToolProvider>('none')
  useEffect(() => {
    if (
      selectedProvider?.presetType === 'openrouter' &&
      builtinToolProvider !== 'none' &&
      builtinToolProvider !== 'openrouter'
    ) {
      setBuiltinToolProvider('none')
    }
  }, [selectedProvider?.presetType, builtinToolProvider])
  const [modalities, setModalities] = useState<ChatModelModality[]>(() =>
    resolveDefaultChatModelModalities(selectedProvider),
  )
  const [modalitiesTouched, setModalitiesTouched] = useState(false)
  useEffect(() => {
    if (modalitiesTouched) return
    const known = resolveKnownChatModelModalities(formData.model)
    setModalities(known ?? resolveDefaultChatModelModalities(selectedProvider))
  }, [formData.model, selectedProvider, modalitiesTouched])
  const toggleModality = (modality: ChatModelModality) => {
    setModalitiesTouched(true)
    setModalities((prev) => {
      if (prev.includes(modality)) {
        if (prev.length === 1) return prev
        return prev.filter((m) => m !== modality)
      }
      return [...prev, modality]
    })
  }
  const [gptWebSearchEnabled, setGptWebSearchEnabled] = useState<boolean>(false)
  const [openRouterWebSearchEnabled, setOpenRouterWebSearchEnabled] =
    useState<boolean>(false)
  const [openRouterWebSearchEngine, setOpenRouterWebSearchEngine] =
    useState<OpenRouterWebSearchEngine>('auto')
  const [
    openRouterWebSearchMaxResultsInput,
    setOpenRouterWebSearchMaxResultsInput,
  ] = useState<string>('')
  const [grokWebSearchEnabled, setGrokWebSearchEnabled] =
    useState<boolean>(false)
  const [geminiWebSearchEnabled, setGeminiWebSearchEnabled] =
    useState<boolean>(false)
  const [geminiUrlContextEnabled, setGeminiUrlContextEnabled] =
    useState<boolean>(false)
  const [modelParamCache, setModelParamCache] = useState<{
    temperature: number
    topP: number
    maxContextTokens: number
    maxOutputTokens: number
  }>(() => ({
    temperature: MODEL_SAMPLING_DEFAULTS.temperature,
    topP: MODEL_SAMPLING_DEFAULTS.topP,
    maxContextTokens: MODEL_SAMPLING_DEFAULTS.maxContextTokens,
    maxOutputTokens: MODEL_SAMPLING_DEFAULTS.maxOutputTokens,
  }))
  const [hasManualMaxContextTokens, setHasManualMaxContextTokens] =
    useState<boolean>(false)
  const customParameterUidRef = useRef(0)
  const createCustomParameterUid = (): string => {
    customParameterUidRef.current += 1
    return `custom-param-${customParameterUidRef.current}`
  }
  const [customParameters, setCustomParameters] = useState<
    CustomParameterFormEntry[]
  >([])

  // Batch add: pick many fetched models at once, save with default settings.
  const [addMode, setAddMode] = useState<'single' | 'batch'>('single')
  const [batchSearchQuery, setBatchSearchQuery] = useState('')
  const [batchSelected, setBatchSelected] = useState<Set<string>>(
    () => new Set(),
  )

  useEffect(() => {
    const fetchModels = async () => {
      if (!selectedProvider) {
        setAvailableModels([])
        setLoadingModels(false)
        return
      }

      // Check cache first
      const cachedModels = plugin.getCachedModelList(
        selectedProvider.id,
        'chat',
      )
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
            plugin.setCachedModelList(selectedProvider.id, fallback, 'chat')
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
              plugin.setCachedModelList(selectedProvider.id, unique, 'chat')
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
          plugin.setCachedModelList(selectedProvider.id, fallback, 'chat')
          return
        }

        if (selectedProvider.presetType === 'gemini-oauth') {
          const service = plugin.getGeminiOAuthService(selectedProvider.id)
          const credential = await service.getUsableCredential()

          if (!credential) {
            const fallback = Array.from(
              new Set(GEMINI_OAUTH_DEFAULT_MODELS),
            ).sort()
            setAvailableModels(fallback)
            plugin.setCachedModelList(selectedProvider.id, fallback, 'chat')
            return
          }

          try {
            const configuredProjectId =
              typeof selectedProvider.additionalSettings?.projectId === 'string'
                ? selectedProvider.additionalSettings.projectId
                : undefined
            const models =
              await service.listAvailableModels(configuredProjectId)
            const unique = Array.from(
              new Set([...(models ?? []), ...GEMINI_OAUTH_DEFAULT_MODELS]),
            ).sort()
            setAvailableModels(unique)
            plugin.setCachedModelList(selectedProvider.id, unique, 'chat')
            return
          } catch (error) {
            console.warn(
              '[YOLO] Failed to fetch Gemini OAuth models, fallback to defaults.',
              error,
            )
            const fallback = Array.from(
              new Set(GEMINI_OAUTH_DEFAULT_MODELS),
            ).sort()
            setAvailableModels(fallback)
            plugin.setCachedModelList(selectedProvider.id, fallback, 'chat')
            return
          }
        }

        if (selectedProvider.presetType === 'qwen-oauth') {
          const models = Array.from(new Set(QWEN_OAUTH_DEFAULT_MODELS)).sort()
          setAvailableModels(models)
          plugin.setCachedModelList(selectedProvider.id, models, 'chat')
          return
        }

        if (selectedProvider.apiType === 'amazon-bedrock') {
          const unique = await listBedrockChatModelIds(selectedProvider)
          setAvailableModels(unique)
          plugin.setCachedModelList(selectedProvider.id, unique, 'chat')
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
                plugin.setCachedModelList(selectedProvider.id, unique, 'chat')
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
          plugin.setCachedModelList(selectedProvider.id, unique, 'chat')
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

  useEffect(() => {
    if (hasManualMaxContextTokens) {
      return
    }

    const matched = resolveKnownMaxContextTokens(formData.model)
    setModelParamCache((prev) => ({
      ...prev,
      maxContextTokens: matched ?? MODEL_SAMPLING_DEFAULTS.maxContextTokens,
    }))
    setFormData((prev) => ({
      ...prev,
      maxContextTokens: matched,
    }))
  }, [formData.model, hasManualMaxContextTokens])

  useEffect(() => {
    if (typeof formData.maxContextTokens === 'number') {
      setMaxContextTokensInput(String(formData.maxContextTokens))
      return
    }
    setMaxContextTokensInput('')
  }, [formData.maxContextTokens])

  const updateMaxContextTokens = (value: number) => {
    const clamped = clampMaxContextTokens(value)
    setHasManualMaxContextTokens(true)
    setModelParamCache((prev) => ({
      ...prev,
      maxContextTokens: clamped,
    }))
    setFormData((prev) => ({
      ...prev,
      maxContextTokens: clamped,
    }))
    setMaxContextTokensInput(String(clamped))
  }

  const resetModelParams = () => {
    setModelParamCache({
      temperature: MODEL_SAMPLING_DEFAULTS.temperature,
      topP: MODEL_SAMPLING_DEFAULTS.topP,
      maxContextTokens:
        resolveKnownMaxContextTokens(formData.model) ??
        MODEL_SAMPLING_DEFAULTS.maxContextTokens,
      maxOutputTokens: MODEL_SAMPLING_DEFAULTS.maxOutputTokens,
    })
    setFormData((prev) => ({
      ...prev,
      temperature: MODEL_SAMPLING_DEFAULTS.temperature,
      topP: MODEL_SAMPLING_DEFAULTS.topP,
      maxContextTokens: resolveKnownMaxContextTokens(prev.model),
      maxOutputTokens: MODEL_SAMPLING_DEFAULTS.maxOutputTokens,
    }))
    setHasManualMaxContextTokens(false)
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

  const setMaxContextTokensEnabled = (enabled: boolean) => {
    setHasManualMaxContextTokens(true)
    setFormData((prev) => {
      const current = prev.maxContextTokens ?? modelParamCache.maxContextTokens
      setModelParamCache((cache) => ({ ...cache, maxContextTokens: current }))
      return { ...prev, maxContextTokens: enabled ? current : undefined }
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
      modalities:
        modalities.length > 0 ? Array.from(new Set(modalities)) : ['text'],
      builtinToolProvider,
      builtinTools: {
        gpt: { webSearch: { enabled: gptWebSearchEnabled } },
        openrouter: {
          webSearch: {
            enabled: openRouterWebSearchEnabled,
            ...(openRouterWebSearchEngine !== 'auto'
              ? { engine: openRouterWebSearchEngine }
              : {}),
            ...((): { maxResults?: number } => {
              const trimmed = openRouterWebSearchMaxResultsInput.trim()
              if (trimmed.length === 0) return {}
              const parsed = Number(trimmed)
              if (!Number.isFinite(parsed)) return {}
              return {
                maxResults: Math.min(
                  OPENROUTER_MAX_RESULTS_MAX,
                  Math.max(OPENROUTER_MAX_RESULTS_MIN, Math.floor(parsed)),
                ),
              }
            })(),
          },
        },
        grok: { webSearch: { enabled: grokWebSearchEnabled } },
        gemini: {
          webSearch: { enabled: geminiWebSearchEnabled },
          urlContext: { enabled: geminiUrlContextEnabled },
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
      reasoningType !== 'none' &&
      !isReasoningTypeCompatible(selectedProvider, reasoningType)
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

  // Models already configured under this provider — used to dedupe the batch
  // list. Keyed by calling id (`model`); display name is intentionally ignored.
  const existingProviderModelIds = useMemo(
    () =>
      new Set(
        plugin.settings.chatModels
          .filter((model) => model.providerId === formData.providerId)
          .map((model) => model.model),
      ),
    [plugin.settings.chatModels, formData.providerId],
  )

  const filteredBatchModels = useMemo(() => {
    const query = batchSearchQuery.trim().toLowerCase()
    return availableModels
      .filter((model) => (query ? model.toLowerCase().includes(query) : true))
      .map((model) => ({
        model,
        alreadyAdded: existingProviderModelIds.has(model),
      }))
  }, [availableModels, batchSearchQuery, existingProviderModelIds])

  const selectableFiltered = filteredBatchModels.filter((m) => !m.alreadyAdded)
  const allFilteredSelected =
    selectableFiltered.length > 0 &&
    selectableFiltered.every((m) => batchSelected.has(m.model))
  const totalSelected = Array.from(batchSelected).filter(
    (model) => !existingProviderModelIds.has(model),
  ).length
  // How many of the fetched models are already configured for this provider —
  // shown so an opened-with-existing-models list doesn't read as empty.
  const addedCount = availableModels.filter((model) =>
    existingProviderModelIds.has(model),
  ).length

  const toggleBatchModel = (model: string) => {
    setBatchSelected((prev) => {
      const next = new Set(prev)
      if (next.has(model)) {
        next.delete(model)
      } else {
        next.add(model)
      }
      return next
    })
  }

  const toggleSelectAllFiltered = () => {
    setBatchSelected((prev) => {
      const next = new Set(prev)
      if (allFilteredSelected) {
        selectableFiltered.forEach((m) => next.delete(m.model))
      } else {
        selectableFiltered.forEach((m) => next.add(m.model))
      }
      return next
    })
  }

  const handleBatchSubmit = () => {
    if (!selectedProvider) {
      new Notice(t('common.error'))
      return
    }
    if (
      !plugin.settings.providers.some(
        (provider) => provider.id === formData.providerId,
      )
    ) {
      new Notice('Provider with this ID does not exist')
      return
    }

    const selectedList = Array.from(batchSelected).filter(
      (model) => !existingProviderModelIds.has(model),
    )
    if (selectedList.length === 0) {
      return
    }

    // Accumulate ids locally so models added in the same batch don't collide.
    const existingIds = plugin.settings.chatModels.map((m) => m.id)
    const newModels: ChatModel[] = []
    for (const model of selectedList) {
      const uniqueId = ensureUniqueModelId(
        existingIds,
        generateModelId(formData.providerId, model),
      )
      existingIds.push(uniqueId)

      const detectedReasoning = detectReasoningTypeFromModelId(model)
      const reasoning = isReasoningTypeCompatible(
        selectedProvider,
        detectedReasoning,
      )
        ? detectedReasoning
        : 'none'
      const knownMaxContext = resolveKnownMaxContextTokens(model)

      const candidate: ChatModel = {
        providerId: formData.providerId,
        id: uniqueId,
        model,
        name: model,
        reasoningType: reasoning,
        modalities:
          resolveKnownChatModelModalities(model) ??
          resolveDefaultChatModelModalities(selectedProvider),
        ...(typeof knownMaxContext === 'number'
          ? { maxContextTokens: knownMaxContext }
          : {}),
      }

      const validationResult = chatModelSchema.safeParse(candidate)
      if (!validationResult.success) {
        new Notice(
          validationResult.error.issues.map((v) => v.message).join('\n'),
        )
        return
      }
      newModels.push(candidate)
    }

    void plugin
      .setSettings({
        ...plugin.settings,
        chatModels: [...plugin.settings.chatModels, ...newModels],
      })
      .then(() => {
        onClose()
      })
      .catch((error) => {
        console.error('Failed to batch add chat models', error)
        new Notice(t('common.error'))
      })
  }

  const modeTabs = [
    {
      key: 'single' as const,
      label: t('settings.models.modeSingle', '单个'),
      Icon: Square,
    },
    {
      key: 'batch' as const,
      label: t('settings.models.modeBatch', '批量'),
      Icon: Layers,
    },
  ]
  const modeSwitcher = (
    <div className="yolo-chat-model-modal-header">
      <h2 className="yolo-chat-model-modal-title">
        {t('settings.models.addCustomChatModel')}
      </h2>
      <div
        className="yolo-model-mode-seg"
        role="tablist"
        style={
          {
            '--yolo-mode-seg-count': modeTabs.length,
            '--yolo-mode-seg-index': addMode === 'single' ? 0 : 1,
          } as CSSProperties
        }
      >
        <div className="yolo-model-mode-seg-glider" aria-hidden="true" />
        {modeTabs.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={addMode === key}
            className={`yolo-model-mode-seg-btn${
              addMode === key ? ' is-active' : ''
            }`}
            onClick={() => setAddMode(key)}
          >
            <span className="yolo-model-mode-seg-icon" aria-hidden="true">
              <Icon size={14} />
            </span>
            <span className="yolo-model-mode-seg-label">{label}</span>
          </button>
        ))}
      </div>
    </div>
  )

  if (addMode === 'batch') {
    return (
      <div className="yolo-chat-model-modal-form">
        {modeSwitcher}

        <div className="yolo-batch-add">
          <input
            type="text"
            className="yolo-batch-add-search"
            value={batchSearchQuery}
            placeholder={t('settings.models.searchModels', '搜索模型...')}
            onChange={(event) => setBatchSearchQuery(event.currentTarget.value)}
            disabled={loadingModels}
          />

          <div className="yolo-batch-add-toolbar">
            <button
              type="button"
              className="yolo-batch-add-selectall"
              onClick={toggleSelectAllFiltered}
              disabled={selectableFiltered.length === 0}
            >
              <span
                className={`yolo-batch-add-check${
                  allFilteredSelected ? ' is-checked' : ''
                }`}
              >
                {allFilteredSelected ? <Check size={12} /> : null}
              </span>
              {t('settings.models.batchSelectAll', '全选')}
            </button>
            <span className="yolo-batch-add-count">
              {addedCount > 0 ? (
                <>
                  {t('settings.models.batchAlreadyAdded', '已添加')}{' '}
                  {addedCount} ·{' '}
                </>
              ) : null}
              {t('settings.models.batchSelected', '已选')} {totalSelected} /{' '}
              {availableModels.length}
            </span>
          </div>

          <div className="yolo-batch-add-list">
            {loadingModels ? (
              <div className="yolo-batch-add-empty">{t('common.loading')}</div>
            ) : loadError ? (
              <div className="yolo-batch-add-empty yolo-batch-add-empty--error">
                {t('settings.models.fetchModelsFailed', '获取模型失败')}：
                {loadError}
              </div>
            ) : filteredBatchModels.length === 0 ? (
              <div className="yolo-batch-add-empty">
                {t('common.noResults', '没有匹配的模型')}
              </div>
            ) : (
              filteredBatchModels.map(({ model, alreadyAdded }) => {
                const checked = batchSelected.has(model)
                return (
                  <div
                    key={model}
                    className={`yolo-batch-add-row${
                      alreadyAdded ? ' is-added' : ''
                    }${checked ? ' is-checked' : ''}`}
                    role={alreadyAdded ? undefined : 'button'}
                    tabIndex={alreadyAdded ? undefined : 0}
                    onClick={
                      alreadyAdded ? undefined : () => toggleBatchModel(model)
                    }
                    onKeyDown={
                      alreadyAdded
                        ? undefined
                        : (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              toggleBatchModel(model)
                            }
                          }
                    }
                  >
                    <span
                      className={`yolo-batch-add-check${
                        checked ? ' is-checked' : ''
                      }`}
                    >
                      {checked ? <Check size={12} /> : null}
                    </span>
                    <span className="yolo-batch-add-row-id">{model}</span>
                    {alreadyAdded ? (
                      <span className="yolo-batch-add-added">
                        {t('settings.models.batchAlreadyAdded', '已添加')}
                      </span>
                    ) : null}
                  </div>
                )
              })
            )}
          </div>

          <div className="yolo-batch-add-hint">
            {t(
              'settings.models.batchHint',
              '批量添加使用默认参数，可在添加后单独调整',
            )}
          </div>
        </div>

        <ObsidianSetting>
          <ObsidianButton
            text={`${t('settings.models.batchAdd', '添加选中模型')}${
              totalSelected > 0 ? ` (${totalSelected})` : ''
            }`}
            onClick={handleBatchSubmit}
            cta
            disabled={totalSelected === 0}
          />
          <ObsidianButton text={t('common.cancel')} onClick={onClose} />
        </ObsidianSetting>
      </div>
    )
  }

  return (
    <div className="yolo-chat-model-modal-form">
      {modeSwitcher}

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
              setReasoningType(detectReasoningTypeFromModelId(value))
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
              setReasoningType(detectReasoningTypeFromModelId(value))
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
          }}
          onChange={(value: string) => {
            setReasoningType(
              isReasoningType(value) ? value : REASONING_TYPES[0],
            )
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

      {/* Built-in (hosted) provider tools selector */}
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
          onChange={(value: string) =>
            setBuiltinToolProvider(
              isBuiltinToolProvider(value) ? value : BUILTIN_TOOL_PROVIDERS[0],
            )
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

      {/* Provider is derived from the current group context; field removed intentionally */}

      <div className="yolo-agent-tools-panel yolo-agent-model-panel">
        <div className="yolo-agent-tools-panel-head yolo-agent-model-panel-head">
          <div className="yolo-agent-tools-panel-title">
            {t('settings.models.customParameters', 'Custom parameters')}
          </div>
          <button
            type="button"
            className="yolo-agent-model-reset"
            onClick={resetModelParams}
          >
            {t('settings.models.restoreDefaults', 'Restore defaults')}
          </button>
        </div>

        <div className="yolo-agent-model-controls">
          <div
            className={`yolo-agent-model-control${
              formData.maxContextTokens === undefined ? ' is-disabled' : ''
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
                  value={formData.maxContextTokens !== undefined}
                  onChange={setMaxContextTokensEnabled}
                />
              </div>
            </div>
            {formData.maxContextTokens !== undefined && (
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
                      formData.maxContextTokens ??
                        modelParamCache.maxContextTokens,
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
                        formData.maxContextTokens ??
                          modelParamCache.maxContextTokens,
                      ),
                    )
                  }}
                />
              </div>
            )}
          </div>

          <div
            className={`yolo-agent-model-control${
              formData.temperature === undefined ? ' is-disabled' : ''
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
                  value={formData.temperature !== undefined}
                  onChange={setTemperatureEnabled}
                />
              </div>
            </div>
            {formData.temperature !== undefined && (
              <div className="yolo-agent-model-control-adjust">
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
                  className="yolo-agent-model-number"
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
            className={`yolo-agent-model-control${
              formData.topP === undefined ? ' is-disabled' : ''
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
                  value={formData.topP !== undefined}
                  onChange={setTopPEnabled}
                />
              </div>
            </div>
            {formData.topP !== undefined && (
              <div className="yolo-agent-model-control-adjust">
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
                  className="yolo-agent-model-number"
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
            className={`yolo-agent-model-control${
              formData.maxOutputTokens === undefined ? ' is-disabled' : ''
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
                  value={formData.maxOutputTokens !== undefined}
                  onChange={setMaxOutputTokensEnabled}
                />
              </div>
            </div>
            {formData.maxOutputTokens !== undefined && (
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
                  className="yolo-agent-model-number"
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
