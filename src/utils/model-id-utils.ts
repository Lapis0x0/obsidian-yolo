/**
 * Utility functions for handling model IDs with provider prefixes
 */

/**
 * Generate a model ID with provider prefix
 * @param providerId - The provider ID (e.g., 'oneapi', 'gemini')
 * @param modelName - The model name (e.g., 'gemini-2.5-flash')
 * @returns The prefixed model ID (e.g., 'oneapi/gemini-2.5-flash')
 */
export function generateModelId(providerId: string, modelName: string): string {
  // If modelName already contains a slash, it might already be prefixed
  if (modelName.includes('/')) {
    return modelName
  }
  return `${providerId}/${modelName}`
}

/**
 * Parse a model ID to extract provider prefix and model name
 * @param modelId - The model ID (e.g., 'oneapi/gemini-2.5-flash' or 'gpt-4')
 * @returns Object containing providerId and modelName
 */
export function parseModelId(modelId: string): {
  providerId: string | null
  modelName: string
} {
  const parts = modelId.split('/')
  if (parts.length === 2) {
    return {
      providerId: parts[0],
      modelName: parts[1],
    }
  }
  // No prefix, return the whole ID as model name
  return {
    providerId: null,
    modelName: modelId,
  }
}

/**
 * Get display name for a model (without provider prefix)
 * @param modelId - The model ID
 * @returns The display name
 */
export function getModelDisplayName(modelId: string): string {
  const { modelName } = parseModelId(modelId)
  return modelName
}

/**
 * Get display name with provider for a model
 * @param modelId - The model ID
 * @param providerName - The provider display name (optional)
 * @returns The display name with provider
 */
export function getModelDisplayNameWithProvider(
  modelId: string,
  providerName?: string,
): string {
  const { providerId, modelName } = parseModelId(modelId)
  if (providerId && providerName) {
    return `${modelName} (${providerName})`
  } else if (providerId) {
    return `${modelName} (${providerId})`
  }
  return modelName
}

/**
 * Check if a model ID has a provider prefix
 * @param modelId - The model ID to check
 * @returns True if the model ID has a provider prefix
 */
export function hasProviderPrefix(modelId: string): boolean {
  return modelId.includes('/')
}

/**
 * Migrate old model ID to new format with provider prefix
 * @param oldModelId - The old model ID without prefix
 * @param providerId - The provider ID to use as prefix
 * @returns The new model ID with prefix
 */
export function migrateModelId(oldModelId: string, providerId: string): string {
  // If already has prefix, return as is
  if (hasProviderPrefix(oldModelId)) {
    return oldModelId
  }
  return generateModelId(providerId, oldModelId)
}

/**
 * Detect reasoning type based on model id keywords.
 * Returns 'openai' when the id looks like GPT/o-series; 'gemini' when it contains 'gemini';
 * 'anthropic' when it contains 'claude'; 'generic' for other reasoning-like keywords; otherwise 'none'.
 */
export function detectReasoningTypeFromModelId(
  modelIdOrName: string,
): 'openai' | 'gemini' | 'anthropic' | 'generic' | 'none' {
  const s = (modelIdOrName || '').toLowerCase()
  if (!s) return 'none'

  // Prefer explicit gemini match
  if (s.includes('gemini')) return 'gemini'

  // Claude / Anthropic
  if (s.includes('claude')) return 'anthropic'

  // Common OpenAI patterns: gpt*, o1/o3/o4 (including variants like o4mini), gpt5
  if (
    s.includes('gpt') ||
    s.includes('o1') ||
    s.includes('o3') ||
    s.includes('o4') ||
    s.includes('gpt5') ||
    s.includes('gpt-5')
  ) {
    return 'openai'
  }

  if (
    s.includes('thinking') ||
    s.includes('reasoning') ||
    s.includes('deepthink')
  ) {
    return 'generic'
  }

  return 'none'
}

/**
 * Ensure a unique model internal id among existing ids by appending a short numeric suffix.
 * Example: base "prov/gemini-2.5-flash" -> "prov/gemini-2.5-flash-2", "...-3", ...
 */
export function ensureUniqueModelId(
  existingIds: string[],
  baseId: string,
): string {
  if (!existingIds.includes(baseId)) return baseId
  let i = 2
  while (existingIds.includes(`${baseId}-${i}`)) i++
  return `${baseId}-${i}`
}
