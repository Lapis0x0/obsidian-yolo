import { ChatModel, ChatModelModality } from '../../types/chat-model.types'

import {
  OPENROUTER_MODEL_CAPABILITIES,
  type OpenRouterChatModelCapability,
} from './openrouter-model-capabilities'

type KnownChatModelCapability = OpenRouterChatModelCapability

// Hand-curated overrides layered on top of the OpenRouter snapshot. Use these
// for official provider IDs that don't appear verbatim in OpenRouter (e.g.
// Anthropic's `-latest` aliases, vendor-specific names) or when we want to
// pin a capability we know the OpenRouter entry gets wrong.
const KNOWN_MODEL_CAPABILITIES: Record<string, KnownChatModelCapability> = {
  ...OPENROUTER_MODEL_CAPABILITIES,
  'claude-opus-4-1': { context: 200000, modalities: ['text', 'vision'] },
  'claude-opus-4-0': { context: 200000, modalities: ['text', 'vision'] },
  'claude-sonnet-4-0': { context: 200000, modalities: ['text', 'vision'] },
  'claude-3-7-sonnet-latest': {
    context: 200000,
    modalities: ['text', 'vision'],
  },
  'claude-3-5-sonnet-latest': {
    context: 200000,
    modalities: ['text', 'vision'],
  },
  'claude-3-5-haiku-latest': {
    context: 200000,
    modalities: ['text', 'vision'],
  },
  'gemini-2.0-flash': { context: 1048576, modalities: ['text', 'vision'] },
  'gemini-2.0-flash-lite': { context: 1048576, modalities: ['text', 'vision'] },
  'deepseek-reasoner': { context: 65536, modalities: ['text'] },
}

export function normalizeModelContextLookupKey(modelId: string): string {
  const trimmed = modelId.trim().toLowerCase()
  if (!trimmed) {
    return ''
  }

  const withoutProviderPrefix = trimmed.includes('/')
    ? trimmed.substring(trimmed.lastIndexOf('/') + 1)
    : trimmed

  return withoutProviderPrefix
}

function getModelLookupCandidates(modelId: string): string[] {
  const normalized = normalizeModelContextLookupKey(modelId)
  if (!normalized) {
    return []
  }

  return Array.from(
    new Set([
      normalized,
      normalized.replace(/(\d)\.(\d)/g, '$1-$2'),
      normalized.replace(/(\d)-(\d)/g, '$1.$2'),
    ]),
  )
}

function resolveKnownCapability(
  modelId: string | undefined,
): KnownChatModelCapability | undefined {
  if (!modelId) return undefined
  for (const candidate of getModelLookupCandidates(modelId)) {
    const matched = KNOWN_MODEL_CAPABILITIES[candidate]
    if (matched) return matched
  }
  return undefined
}

export function resolveKnownMaxContextTokens(
  modelId: string | undefined,
): number | undefined {
  return resolveKnownCapability(modelId)?.context
}

export function resolveKnownChatModelModalities(
  modelId: string | undefined,
): ChatModelModality[] | undefined {
  const modalities = resolveKnownCapability(modelId)?.modalities
  return modalities ? [...modalities] : undefined
}

export function applyKnownMaxContextTokensToChatModels(models: ChatModel[]): {
  chatModels: ChatModel[]
  changed: boolean
} {
  let changed = false

  const chatModels = models.map((model) => {
    if (typeof model.maxContextTokens === 'number') {
      return model
    }

    const matched = resolveKnownMaxContextTokens(model.model ?? model.id)
    if (matched === undefined) {
      return model
    }

    changed = true
    return {
      ...model,
      maxContextTokens: matched,
    }
  })

  return { chatModels, changed }
}
