import { GoogleGenAI } from '@google/genai'
import { App, Notice, requestUrl } from 'obsidian'
import { useEffect, useState } from 'react'

import { DEFAULT_PROVIDERS } from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import { extractEmbeddingVector } from '../../../core/llm/embedding-utils'
import { getProviderClient } from '../../../core/llm/manager'
import { supportedDimensionsForIndex } from '../../../database/schema'
import SmartComposerPlugin from '../../../main'
import {
  EmbeddingModel,
  embeddingModelSchema,
} from '../../../types/embedding-model.types'
import { LLMProvider } from '../../../types/provider.types'
import {
  ensureUniqueModelId,
  generateModelId,
} from '../../../utils/model-id-utils'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ReactModal } from '../../common/ReactModal'
import { SearchableDropdown } from '../../common/SearchableDropdown'
import { ConfirmModal } from '../../modals/ConfirmModal'

type AddEmbeddingModelModalComponentProps = {
  plugin: SmartComposerPlugin
  provider?: LLMProvider
}

const MODEL_IDENTIFIER_KEYS = ['id', 'name', 'model'] as const

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

export class AddEmbeddingModelModal extends ReactModal<AddEmbeddingModelModalComponentProps> {
  constructor(app: App, plugin: SmartComposerPlugin, provider?: LLMProvider) {
    super({
      app: app,
      Component: AddEmbeddingModelModalComponent,
      props: { plugin, provider },
      options: {
        title: 'Add custom embedding model', // Will be translated in component
      },
      plugin: plugin,
    })
  }
}

function AddEmbeddingModelModalComponent({
  plugin,
  onClose,
  provider,
}: AddEmbeddingModelModalComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const selectedProvider: LLMProvider | undefined =
    provider ?? plugin.settings.providers[0]
  const initialProviderId = selectedProvider?.id ?? DEFAULT_PROVIDERS[0].id
  const initialProviderType =
    selectedProvider?.type ?? DEFAULT_PROVIDERS[0].type
  const [formData, setFormData] = useState<Omit<EmbeddingModel, 'dimension'>>({
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

  // Sort models with embedding-related ones first
  const sortModelsForEmbedding = (models: string[]): string[] => {
    const embeddingKeywords = ['embedding', 'embed', 'text-embedding']
    const embeddingModels: string[] = []
    const otherModels: string[] = []

    models.forEach((model) => {
      const modelLower = model.toLowerCase()
      if (embeddingKeywords.some((keyword) => modelLower.includes(keyword))) {
        embeddingModels.push(model)
      } else {
        otherModels.push(model)
      }
    })

    return [...embeddingModels.sort(), ...otherModels.sort()]
  }

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
        const sorted = sortModelsForEmbedding(cachedModels)
        setAvailableModels(sorted)
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
                const unique = Array.from(new Set(buckets))
                const sorted = sortModelsForEmbedding(unique)
                setAvailableModels(sorted)
                // Cache the result (unsorted for consistency)
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
          const ai = new GoogleGenAI({ apiKey: selectedProvider.apiKey ?? '' })
          const pager = await ai.models.list()
          const names: string[] = []
          for await (const entry of pager) {
            const raw = extractModelIdentifier(entry) ?? ''
            if (!raw) continue
            // Normalize like "models/text-embedding-004" -> "text-embedding-004"
            const norm = raw.includes('/') ? raw.split('/').pop()! : raw
            // Keep embedding models and general gemini models
            if (
              norm.toLowerCase().includes('embedding') ||
              norm.toLowerCase().includes('gemini')
            ) {
              names.push(norm)
            }
          }
          // Sort with embedding models first
          const unique = Array.from(new Set(names))
          const sorted = sortModelsForEmbedding(unique)
          setAvailableModels(sorted)
          // Cache the result (unsorted for consistency)
          plugin.setCachedModelList(selectedProvider.id, unique)
          return
        }
      } catch (err: unknown) {
        console.error('Failed to auto fetch embedding models', err)
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
    const run = async () => {
      // Generate internal id (provider/model) and ensure uniqueness by suffix if needed
      const baseInternalId = generateModelId(
        formData.providerId,
        formData.model,
      )
      const existingIds = plugin.settings.embeddingModels.map((m) => m.id)
      const modelIdWithPrefix = ensureUniqueModelId(existingIds, baseInternalId)

      if (
        !plugin.settings.providers.some(
          (provider) => provider.id === formData.providerId,
        )
      ) {
        throw new Error('Provider with this ID does not exist')
      }

      const providerClient = getProviderClient({
        settings: plugin.settings,
        providerId: formData.providerId,
      })

      const embeddingResult = await providerClient.getEmbedding(
        formData.model,
        'test',
      )
      const dimension = extractEmbeddingVector(embeddingResult).length

      if (!supportedDimensionsForIndex.includes(dimension)) {
        const confirmed = await new Promise<boolean>((resolve) => {
          new ConfirmModal(plugin.app, {
            title: 'Performance warning',
            message: `This model outputs ${dimension} dimensions, but the optimized dimensions for database indexing are: ${supportedDimensionsForIndex.join(
              ', ',
            )}.\n\nThis may result in slower search performance.\n\nDo you want to continue anyway?`,
            onConfirm: () => resolve(true),
            onCancel: () => resolve(false),
          }).open()
        })

        if (!confirmed) {
          return
        }
      }

      const embeddingModel: EmbeddingModel = {
        ...formData,
        id: modelIdWithPrefix,
        name:
          formData.name && formData.name.trim().length > 0
            ? formData.name
            : formData.model,
        dimension,
      }

      const validationResult = embeddingModelSchema.safeParse(embeddingModel)

      if (!validationResult.success) {
        throw new Error(
          validationResult.error.issues.map((v) => v.message).join('\n'),
        )
      }

      await plugin.setSettings({
        ...plugin.settings,
        embeddingModels: [...plugin.settings.embeddingModels, embeddingModel],
      })

      onClose()
    }

    void run().catch((error) => {
      new Notice(
        error instanceof Error ? error.message : 'An unknown error occurred',
      )
    })
  }

  return (
    <>
      {/* Available models dropdown (moved above other fields) */}
      <ObsidianSetting
        name={
          loadingModels
            ? t('common.loading')
            : t('settings.models.availableModelsAuto')
        }
        desc={
          loadError
            ? `${t('settings.models.fetchModelsFailed')}：${loadError}`
            : t('settings.models.embeddingModelsFirst')
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
          }}
          disabled={loadingModels || availableModels.length === 0}
          loading={loadingModels}
          placeholder={t('settings.models.searchModels') || 'Search models...'}
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

      {/* Model calling ID */}
      <ObsidianSetting
        name={t('settings.models.modelId')}
        desc={t('settings.models.modelIdDesc')}
        required
      >
        <ObsidianTextInput
          value={formData.model}
          placeholder={t('settings.models.modelIdPlaceholder')}
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, model: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting>
        <ObsidianButton text={t('common.add')} onClick={handleSubmit} cta />
        <ObsidianButton text={t('common.cancel')} onClick={onClose} />
      </ObsidianSetting>
    </>
  )
}
