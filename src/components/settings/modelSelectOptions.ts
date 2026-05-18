import type { ChatModel } from '../../types/chat-model.types'
import type { LLMProvider } from '../../types/provider.types'
import type { SimpleSelectOptionGroup } from '../common/SimpleSelect'

export function getChatModelDisplayLabel(model: ChatModel): string {
  return model.name?.trim() || model.model || model.id
}

export function buildChatModelOptionGroups({
  chatModels,
  providers,
  excludeModelIds,
}: {
  chatModels: ChatModel[]
  providers: LLMProvider[]
  excludeModelIds?: Set<string>
}): SimpleSelectOptionGroup[] {
  const providerOrder = providers.map((provider) => provider.id)
  const providerIdsInModels = Array.from(
    new Set(chatModels.map((model) => model.providerId)),
  )
  const orderedProviderIds = [
    ...providerOrder.filter((id) => providerIdsInModels.includes(id)),
    ...providerIdsInModels.filter((id) => !providerOrder.includes(id)),
  ]

  return orderedProviderIds.flatMap((providerId) => {
    const models = chatModels.filter(
      (model) =>
        model.providerId === providerId && !excludeModelIds?.has(model.id),
    )
    if (models.length === 0) {
      return []
    }
    const group: SimpleSelectOptionGroup = {
      label: providerId,
      options: models.map((model) => ({
        value: model.id,
        label: getChatModelDisplayLabel(model),
        description: [providerId, model.model].filter(Boolean).join(' | '),
      })),
    }
    return [group]
  })
}
