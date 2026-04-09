import { ChatModel } from '../../types/chat-model.types'

import { OPENROUTER_MODEL_CONTEXT_TOKENS } from './openrouter-model-contexts'

const KNOWN_MODEL_CONTEXT_TOKENS: Record<string, number> = {
  ...OPENROUTER_MODEL_CONTEXT_TOKENS,
  'claude-opus-4-1': 200000,
  'claude-opus-4-0': 200000,
  'claude-sonnet-4-0': 200000,
  'claude-3-7-sonnet-latest': 200000,
  'claude-3-5-sonnet-latest': 200000,
  'claude-3-5-haiku-latest': 200000,
  'gemini-2.0-flash': 1048576,
  'gemini-2.0-flash-lite': 1048576,
  'deepseek-reasoner': 65536,
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

function getModelContextLookupCandidates(modelId: string): string[] {
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

export function resolveKnownMaxContextTokens(
  modelId: string | undefined,
): number | undefined {
  if (!modelId) {
    return undefined
  }

  const candidates = getModelContextLookupCandidates(modelId)
  for (const candidate of candidates) {
    const matched = KNOWN_MODEL_CONTEXT_TOKENS[candidate]
    if (matched !== undefined) {
      return matched
    }
  }

  return undefined
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
