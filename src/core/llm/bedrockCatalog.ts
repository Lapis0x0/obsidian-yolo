import {
  BedrockClient,
  FoundationModelSummary,
  ListFoundationModelsCommand,
} from '@aws-sdk/client-bedrock'

import { LLMProvider } from '../../types/provider.types'
import {
  createBedrockBearerClientConfig,
  isSupportedBedrockEmbeddingModel,
} from '../../utils/llm/bedrock'

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

async function listFoundationModels(
  provider: Pick<LLMProvider, 'apiKey' | 'additionalSettings'>,
  byOutputModality: 'TEXT' | 'EMBEDDING',
): Promise<FoundationModelSummary[]> {
  const client = new BedrockClient(createBedrockBearerClientConfig(provider))
  const response = await client.send(
    new ListFoundationModelsCommand({
      byOutputModality,
      byInferenceType: 'ON_DEMAND',
    }),
  )

  return response.modelSummaries ?? []
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
