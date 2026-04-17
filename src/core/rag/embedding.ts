import { SmartComposerSettings } from '../../settings/schema/setting.types'
import { EmbeddingModelClient } from '../../types/embedding'
import { getProviderClient } from '../llm/manager'

export const getEmbeddingModelClient = ({
  settings,
  embeddingModelId,
}: {
  settings: SmartComposerSettings
  embeddingModelId: string
}): EmbeddingModelClient => {
  const embeddingModel = settings.embeddingModels.find(
    (model) => model.id === embeddingModelId,
  )
  if (!embeddingModel) {
    throw new Error(`Embedding model ${embeddingModelId} not found`)
  }

  const providerClient = getProviderClient({
    settings,
    providerId: embeddingModel.providerId,
  })

  return {
    id: embeddingModel.id,
    dimension: embeddingModel.dimension,
    getEmbedding: async (text: string) => {
      const vector = await providerClient.getEmbedding(
        embeddingModel.model,
        text,
        { dimensions: embeddingModel.dimension },
      )
      if (vector.length !== embeddingModel.dimension) {
        throw new Error(
          `Embedding model "${embeddingModel.id}" returned ${vector.length}-dimensional vector, but it is configured as ${embeddingModel.dimension}-dimensional. Update the model's dimension in settings or re-add the model.`,
        )
      }
      return vector
    },
  }
}
