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
  'qwen-oauth',
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

export type LLMProviderPresetType = z.infer<typeof providerPresetTypeSchema>
export type LLMProviderApiType = z.infer<typeof providerApiTypeSchema>

const KNOWN_PRESET_TYPES = new Set<string>(providerPresetTypeSchema.options)
const KNOWN_API_TYPES = new Set<string>(providerApiTypeSchema.options)

const normalizePresetType = (raw: unknown): LLMProviderPresetType => {
  if (typeof raw !== 'string') return 'openai-compatible'
  if (raw === 'kimi') return 'moonshot'
  return KNOWN_PRESET_TYPES.has(raw)
    ? (raw as LLMProviderPresetType)
    : 'openai-compatible'
}

const normalizeApiType = (
  raw: unknown,
  presetType: LLMProviderPresetType,
): LLMProviderApiType => {
  if (typeof raw === 'string' && KNOWN_API_TYPES.has(raw)) {
    return raw as LLMProviderApiType
  }
  return getDefaultApiTypeForPresetType(presetType)
}

export function getDefaultRequestTransportModeForPresetType(
  presetType: LLMProviderPresetType,
  isDesktop: boolean,
): RequestTransportMode | undefined {
  if (
    isDesktop &&
    (presetType === 'chatgpt-oauth' ||
      presetType === 'gemini-oauth' ||
      presetType === 'qwen-oauth')
  ) {
    return 'node'
  }

  return undefined
}

const DEFAULT_PROVIDER_API_TYPE_BY_PRESET: Record<
  LLMProviderPresetType,
  LLMProviderApiType
> = {
  openai: 'openai-responses',
  'chatgpt-oauth': 'openai-responses',
  'gemini-oauth': 'gemini',
  'qwen-oauth': 'openai-compatible',
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

// Lenient input schema. Unknown enum-like values (preset/api types from a
// newer plugin version, or hand-edited data) are accepted here and normalized
// in the transform below — schema-level rejection would silently drop the
// whole provider via `resilientArraySchema`, which has bitten cross-device
// sync users hard. The strict enum contract still applies on the OUTPUT
// (`normalizedLlmProviderSchema`), so downstream code keeps narrow types.
const baseLlmProviderInputSchema = z.object({
  id: z.string().min(1, 'id is required'),
  type: z.string().optional(),
  presetType: z.string().optional(),
  apiType: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  additionalSettings: z.record(z.string(), z.unknown()).optional(),
  customHeaders: z
    .array(z.unknown())
    .transform((items): ProviderHeader[] =>
      items.flatMap((item) => {
        const parsed = providerHeaderSchema.safeParse(item)
        return parsed.success ? [parsed.data] : []
      }),
    )
    .optional(),
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
    const presetType = normalizePresetType(value.presetType ?? value.type)
    const apiType = normalizeApiType(value.apiType, presetType)

    return {
      id: value.id,
      presetType,
      apiType,
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
