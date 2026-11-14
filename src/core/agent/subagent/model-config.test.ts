import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { ChatModel } from '../../../types/chat-model.types'

import {
  normalizeSubagentModelOptions,
  resolveSubagentModelConfig,
} from './model-config'

const SUBAGENT_CAPABILITY_ID = 'subagent_delegation'

const chatModel = (id: string): ChatModel => ({
  providerId: 'provider',
  id,
  model: `${id}-model`,
})

const createSettings = ({
  modelIds,
  chatModelId,
  allowedModelIds,
  preferredModelId,
}: {
  modelIds: string[]
  chatModelId?: string
  allowedModelIds?: string[]
  preferredModelId?: string
}): YoloSettings => {
  const chatModels = modelIds.map(chatModel)
  return {
    chatModels,
    chatModelId: chatModelId ?? chatModels[0]?.id ?? '',
    mcp: {
      builtinCapabilityOptions: {
        [SUBAGENT_CAPABILITY_ID]: {
          ...(allowedModelIds !== undefined ? { allowedModelIds } : {}),
          ...(preferredModelId !== undefined ? { preferredModelId } : {}),
        },
      },
    },
  } as unknown as YoloSettings
}

describe('resolveSubagentModelConfig', () => {
  it('falls back to the default chat model when allowedModelIds is an empty array (#643)', () => {
    // Repro from #643: the user pinned a model, then removed it from the pool,
    // leaving `[]` persisted. "Nothing pinned" must mean "use the default".
    const settings = createSettings({
      modelIds: ['default-model', 'other-model'],
      chatModelId: 'default-model',
      allowedModelIds: [],
    })

    expect(resolveSubagentModelConfig(settings).allowedModelIds).toEqual([
      'default-model',
    ])
  })

  it('falls back to the default chat model when the field is absent', () => {
    const settings = createSettings({
      modelIds: ['default-model', 'other-model'],
      chatModelId: 'default-model',
    })

    expect(resolveSubagentModelConfig(settings).allowedModelIds).toEqual([
      'default-model',
    ])
  })

  it('falls back to the default chat model when every saved id left the pool', () => {
    const settings = createSettings({
      modelIds: ['default-model', 'other-model'],
      chatModelId: 'default-model',
      allowedModelIds: ['deleted-model'],
    })

    expect(resolveSubagentModelConfig(settings).allowedModelIds).toEqual([
      'default-model',
    ])
  })

  it('keeps a non-empty saved allow-list, dropping unknown and duplicate ids', () => {
    const settings = createSettings({
      modelIds: ['a', 'b', 'default-model'],
      chatModelId: 'default-model',
      allowedModelIds: ['b', 'gone', 'b', 'a'],
    })

    expect(resolveSubagentModelConfig(settings).allowedModelIds).toEqual([
      'b',
      'a',
    ])
  })

  it('uses the first registered model when the default chat model is not registered', () => {
    const settings = createSettings({
      modelIds: ['a', 'b'],
      chatModelId: 'missing-default',
      allowedModelIds: [],
    })

    expect(resolveSubagentModelConfig(settings).allowedModelIds).toEqual(['a'])
  })

  it('returns an empty list only when no chat model is registered at all', () => {
    const settings = createSettings({ modelIds: [], allowedModelIds: [] })

    expect(resolveSubagentModelConfig(settings).allowedModelIds).toEqual([])
  })

  it('re-points the preferred model when it is no longer allowed', () => {
    const settings = createSettings({
      modelIds: ['default-model', 'other-model'],
      chatModelId: 'default-model',
      allowedModelIds: [],
      preferredModelId: 'deleted-model',
    })

    expect(resolveSubagentModelConfig(settings).preferredModelId).toBe(
      'default-model',
    )
  })
})

describe('normalizeSubagentModelOptions', () => {
  it('rewrites a persisted empty allow-list to the default model (#643)', () => {
    const settings = createSettings({
      modelIds: ['default-model', 'other-model'],
      chatModelId: 'default-model',
      allowedModelIds: [],
    })

    const normalized = normalizeSubagentModelOptions(settings)
    const options =
      normalized.mcp.builtinCapabilityOptions[SUBAGENT_CAPABILITY_ID]

    expect(options?.allowedModelIds).toEqual(['default-model'])
    expect(options?.preferredModelId).toBe('default-model')
  })

  it('leaves settings untouched when the stored options already match', () => {
    const settings = createSettings({
      modelIds: ['default-model', 'other-model'],
      chatModelId: 'default-model',
      allowedModelIds: ['other-model'],
      preferredModelId: 'other-model',
    })

    expect(normalizeSubagentModelOptions(settings)).toBe(settings)
  })
})
