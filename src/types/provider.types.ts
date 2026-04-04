import { z } from 'zod'

const providerHeaderSchema = z.object({
  key: z
    .string({
      required_error: 'header key is required',
    })
    .min(1, 'header key is required'),
  value: z.string().default(''),
})

export const requestTransportModeSchema = z.enum([
  'auto',
  'browser',
  'obsidian',
  'node',
])

export const providerPresetTypeSchema = z.enum([
  'openai',
  'chatgpt-oauth',
  'gemini-oauth',
  'anthropic',
  'gemini',
  'deepseek',
  'moonshot',
  'perplexity',
  'groq',
  'mistral',
  'openrouter',
  'ollama',
  'lm-studio',
  'morph',
  'azure-openai',
  'amazon-bedrock',
  'openai-compatible',
])

export const providerApiTypeSchema = z.enum([
  'openai-compatible',
  'openai-responses',
  'anthropic',
  'gemini',
  'amazon-bedrock',
])

const legacyProviderPresetTypeInputSchema = z.union([
  providerPresetTypeSchema,
  z.literal('kimi'),
])

export type LLMProviderPresetType = z.infer<typeof providerPresetTypeSchema>
export type LLMProviderApiType = z.infer<typeof providerApiTypeSchema>

const DEFAULT_PROVIDER_API_TYPE_BY_PRESET: Record<
  LLMProviderPresetType,
  LLMProviderApiType
> = {
  openai: 'openai-responses',
  'chatgpt-oauth': 'openai-responses',
  'gemini-oauth': 'gemini',
  anthropic: 'anthropic',
  gemini: 'gemini',
  deepseek: 'openai-compatible',
  moonshot: 'openai-compatible',
  perplexity: 'openai-compatible',
  groq: 'openai-compatible',
  mistral: 'openai-compatible',
  openrouter: 'openai-compatible',
  ollama: 'openai-compatible',
  'lm-studio': 'openai-compatible',
  morph: 'openai-compatible',
  'azure-openai': 'openai-compatible',
  'amazon-bedrock': 'amazon-bedrock',
  'openai-compatible': 'openai-compatible',
}

export function getDefaultApiTypeForPresetType(
  presetType: LLMProviderPresetType,
): LLMProviderApiType {
  return DEFAULT_PROVIDER_API_TYPE_BY_PRESET[presetType]
}

export function getSupportedApiTypesForPresetType(
  presetType: LLMProviderPresetType,
): readonly LLMProviderApiType[] {
  const defaults = new Set<LLMProviderApiType>([
    getDefaultApiTypeForPresetType(presetType),
  ])

  switch (presetType) {
    case 'anthropic':
      defaults.add('openai-compatible')
      break
    case 'gemini':
      defaults.add('openai-compatible')
      break
    case 'amazon-bedrock':
      defaults.add('openai-compatible')
      break
    default:
      defaults.add('openai-compatible')
      defaults.add('openai-responses')
      defaults.add('anthropic')
      defaults.add('gemini')
      break
  }

  return [...defaults]
}

const baseLlmProviderInputSchema = z.object({
  id: z.string().min(1, 'id is required'),
  type: legacyProviderPresetTypeInputSchema.optional(),
  presetType: legacyProviderPresetTypeInputSchema.optional(),
  apiType: providerApiTypeSchema.optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  additionalSettings: z.record(z.string(), z.unknown()).optional(),
  customHeaders: z.array(providerHeaderSchema).optional(),
})

const normalizedLlmProviderSchema = z.object({
  id: z.string().min(1, 'id is required'),
  presetType: providerPresetTypeSchema,
  apiType: providerApiTypeSchema,
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  additionalSettings: z.record(z.string(), z.unknown()).optional(),
  customHeaders: z.array(providerHeaderSchema).optional(),
})

/**
 * When adding a new provider, make sure to update these files:
 * - src/constants.ts
 * - src/types/chat-model.types.ts
 * - src/types/embedding-model.types.ts
 * - src/core/llm/manager.ts
 */
export const llmProviderSchema = baseLlmProviderInputSchema
  .transform((value) => {
    const rawPresetType = value.presetType ?? value.type ?? 'openai-compatible'
    const presetType = rawPresetType === 'kimi' ? 'moonshot' : rawPresetType

    return {
      id: value.id,
      presetType,
      apiType: value.apiType ?? getDefaultApiTypeForPresetType(presetType),
      ...(value.baseUrl !== undefined ? { baseUrl: value.baseUrl } : {}),
      ...(value.apiKey !== undefined ? { apiKey: value.apiKey } : {}),
      ...(value.additionalSettings !== undefined
        ? { additionalSettings: value.additionalSettings }
        : {}),
      ...(value.customHeaders !== undefined
        ? { customHeaders: value.customHeaders }
        : {}),
    }
  })
  .pipe(normalizedLlmProviderSchema)

export type LLMProvider = z.infer<typeof llmProviderSchema>
export type ProviderHeader = z.infer<typeof providerHeaderSchema>
export type RequestTransportMode = z.infer<typeof requestTransportModeSchema>
