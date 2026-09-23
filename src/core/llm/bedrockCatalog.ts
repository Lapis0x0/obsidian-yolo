import { requestUrl } from 'obsidian'

import { LLMProvider } from '../../types/provider.types'
import {
  createBedrockBearerClientConfig,
  isSupportedBedrockEmbeddingModel,
} from '../../utils/llm/bedrock'

// The subset of Bedrock's ListFoundationModels summary this catalog reads.
type FoundationModelSummary = {
  modelId?: string
  inputModalities?: string[]
  outputModalities?: string[]
  modelLifecycle?: { status?: string }
}

const getModelId = (model: FoundationModelSummary): string | null => {
  const modelId = model.modelId?.trim()
  return modelId ? modelId : null
}

const isActiveModel = (model: FoundationModelSummary): boolean => {
  return model.modelLifecycle?.status !== 'LEGACY'
}

const hasTextInput = (model: FoundationModelSummary): boolean => {
  return model.inputModalities?.includes('TEXT') === true
}

const hasTextOutput = (model: FoundationModelSummary): boolean => {
  return model.outputModalities?.includes('TEXT') === true
}

const hasEmbeddingOutput = (model: FoundationModelSummary): boolean => {
  return model.outputModalities?.includes('EMBEDDING') === true
}

const isLikelyEmbeddingModel = (model: FoundationModelSummary): boolean => {
  const modelId = getModelId(model)?.toLowerCase() ?? ''
  return modelId.includes('embed')
}

type ListFoundationModelsResponse = {
  modelSummaries?: FoundationModelSummary[]
  // Bedrock error bodies use either casing depending on the failing layer.
  message?: string
  Message?: string
}

const parseResponse = (text: string): ListFoundationModelsResponse => {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object'
      ? (parsed as ListFoundationModelsResponse)
      : {}
  } catch {
    return {}
  }
}

async function listFoundationModels(
  provider: Pick<LLMProvider, 'apiKey' | 'additionalSettings'>,
  byOutputModality: 'TEXT' | 'EMBEDDING',
): Promise<FoundationModelSummary[]> {
  const { region, token } = createBedrockBearerClientConfig(provider)
  const query = new URLSearchParams({
    byOutputModality,
    byInferenceType: 'ON_DEMAND',
  })
  const response = await requestUrl({
    url: `https://bedrock.${region}.amazonaws.com/foundation-models?${query.toString()}`,
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token.token}`,
    },
    throw: false,
  })
  const json = parseResponse(response.text)
  if (response.status < 200 || response.status >= 300) {
    const detail = json.message ?? json.Message
    throw new Error(
      `Failed to fetch models: ${response.status}${detail ? ` ${detail}` : ''}`,
    )
  }

  return json.modelSummaries ?? []
}

export async function listBedrockChatModelIds(
  provider: Pick<LLMProvider, 'apiKey' | 'additionalSettings'>,
): Promise<string[]> {
  const models = await listFoundationModels(provider, 'TEXT')

  return models
    .filter((model) => isActiveModel(model) && hasTextInput(model))
    .filter((model) => !hasEmbeddingOutput(model) || hasTextOutput(model))
    .filter((model) => !isLikelyEmbeddingModel(model))
    .map((model) => getModelId(model))
    .filter((modelId): modelId is string => Boolean(modelId))
    .sort()
}

export async function listBedrockEmbeddingModelIds(
  provider: Pick<LLMProvider, 'apiKey' | 'additionalSettings'>,
): Promise<string[]> {
  const models = await listFoundationModels(provider, 'EMBEDDING')

  return models
    .filter((model) => isActiveModel(model) && hasTextInput(model))
    .map((model) => getModelId(model))
    .filter((modelId): modelId is string => Boolean(modelId))
    .filter((modelId) => isSupportedBedrockEmbeddingModel(modelId))
    .sort()
}
