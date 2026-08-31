import { YoloSettings } from '../../settings/schema/setting.types'
import { EmbeddingModelClient } from '../../types/embedding'
import { getProviderClient } from '../llm/manager'

import { getLocalEmbeddingModelManager } from './local-embedding/access'
import { getLocalEmbeddingCatalogEntry } from './local-embedding/catalog'
import { createLocalEmbeddingClient } from './local-embedding/client'
import { LOCAL_EMBEDDING_PROVIDER_ID } from './local-embedding/constants'

type RawGetEmbedding = (
  text: string,
  options?: { kind?: 'query' | 'document' },
) => Promise<number[]>

function buildRemoteEmbedding(
  settings: YoloSettings,
  embeddingModel: YoloSettings['embeddingModels'][number],
): RawGetEmbedding {
  const providerClient = getProviderClient({
    settings,
    providerId: embeddingModel.providerId,
  })
  return (text) => {
    const shouldSendDimensions =
      embeddingModel.nativeDimension != null &&
      embeddingModel.dimension !== embeddingModel.nativeDimension
    return providerClient.getEmbedding(
      embeddingModel.model,
      text,
      shouldSendDimensions
        ? { dimensions: embeddingModel.dimension }
        : undefined,
    )
  }
}

function buildLocalEmbedding(
  embeddingModel: YoloSettings['embeddingModels'][number],
): {
  getEmbedding: RawGetEmbedding
  dispose: () => void | Promise<void>
  releaseIdleSession: () => void | Promise<void>
} {
  // `model` holds the catalog slug for local entries — see
  // `docs/plans/08-22-local-embedding/00-plan.md` §3.5 and
  // `local-embedding/catalog.ts`'s `LocalEmbeddingCatalogEntry.id`.
  const catalogEntry = getLocalEmbeddingCatalogEntry(embeddingModel.model)
  if (!catalogEntry) {
    throw new Error(
      `Local embedding model catalog entry "${embeddingModel.model}" not found`,
    )
  }
  const manager = getLocalEmbeddingModelManager()
  if (!manager) {
    throw new Error(
      'Local embedding models are not available on this platform.',
    )
  }
  const client = createLocalEmbeddingClient({ catalogEntry, manager })
  return {
    getEmbedding: (text, options) => client.getEmbedding(text, options),
    dispose: () => client.dispose(),
    releaseIdleSession: () => client.releaseIdleSession(),
  }
}

export const getEmbeddingModelClient = ({
  settings,
  embeddingModelId,
}: {
  settings: YoloSettings
  embeddingModelId: string
}): EmbeddingModelClient => {
  const embeddingModel = settings.embeddingModels.find(
    (model) => model.id === embeddingModelId,
  )
  if (!embeddingModel) {
    throw new Error(`Embedding model ${embeddingModelId} not found`)
  }

  const isLocal = embeddingModel.providerId === LOCAL_EMBEDDING_PROVIDER_ID
  const {
    getEmbedding: rawGetEmbedding,
    dispose,
    releaseIdleSession,
  } = isLocal
    ? buildLocalEmbedding(embeddingModel)
    : {
        getEmbedding: buildRemoteEmbedding(settings, embeddingModel),
        dispose: undefined,
        releaseIdleSession: undefined,
      }

  return {
    id: embeddingModel.id,
    dimension: embeddingModel.dimension,
    dispose,
    releaseIdleSession,
    getEmbedding: async (text, options) => {
      const vector = await rawGetEmbedding(text, options)
      if (vector.length !== embeddingModel.dimension) {
        throw new Error(
          `Embedding model "${embeddingModel.id}" returned ${vector.length}-dimensional vector, but it is configured as ${embeddingModel.dimension}-dimensional. Update the model's dimension in settings or re-add the model.`,
        )
      }
      return vector
    },
  }
}
