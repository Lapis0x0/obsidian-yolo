import { ChatModel } from './types/chat-model.types'
import { EmbeddingModel } from './types/embedding-model.types'
import { LLMProvider, LLMProviderType } from './types/provider.types'

export const CHAT_VIEW_TYPE = 'smtcmp-chat-view'
export const APPLY_VIEW_TYPE = 'smtcmp-apply-view'

export const PGLITE_DB_PATH = '.smtcmp_vector_db.tar.gz'
export const PLUGIN_ID = 'obsidian-smart-composer'

// Default model ids (with provider prefix)
export const DEFAULT_CHAT_MODEL_ID = 'openai/gpt-5'
export const DEFAULT_APPLY_MODEL_ID = 'openai/gpt-4.1-mini'

// Recommended model ids (with provider prefix)
export const RECOMMENDED_MODELS_FOR_CHAT = [
  'anthropic/claude-sonnet-4.0',
  'openai/gpt-4.1',
]
export const RECOMMENDED_MODELS_FOR_APPLY = ['openai/gpt-4.1-mini']
export const RECOMMENDED_MODELS_FOR_EMBEDDING = [
  'openai/text-embedding-3-small',
]

export const DEFAULT_CHAT_TITLE_PROMPT = {
  en: "You are a title generator. Generate a concise conversation title from the user's first message. Output the title only.",
  zh: '你是一个标题生成器。请基于用户的第一条消息生成一个简洁的会话标题，直接输出标题本身。',
  it: "Sei un generatore di titoli. Genera un titolo di conversazione conciso dal primo messaggio dell'utente. Restituisci solo il titolo.",
} as const

export const PROVIDER_TYPES_INFO = {
  openai: {
    label: 'OpenAI',
    defaultProviderId: 'openai',
    requireApiKey: true,
    requireBaseUrl: false,
    supportEmbedding: true,
    additionalSettings: [],
  },
  anthropic: {
    label: 'Anthropic',
    defaultProviderId: 'anthropic',
    requireApiKey: true,
    requireBaseUrl: false,
    supportEmbedding: false,
    additionalSettings: [],
  },
  gemini: {
    label: 'Gemini',
    defaultProviderId: 'gemini',
    requireApiKey: true,
    requireBaseUrl: false,
    supportEmbedding: true,
    additionalSettings: [],
  },
  groq: {
    label: 'Groq',
    defaultProviderId: 'groq',
    requireApiKey: true,
    requireBaseUrl: false,
    supportEmbedding: false,
    additionalSettings: [],
  },
  openrouter: {
    label: 'OpenRouter',
    defaultProviderId: 'openrouter',
    requireApiKey: true,
    requireBaseUrl: false,
    supportEmbedding: true,
    additionalSettings: [],
  },
  ollama: {
    label: 'Ollama',
    defaultProviderId: 'ollama',
    requireApiKey: false,
    requireBaseUrl: false,
    supportEmbedding: true,
    additionalSettings: [],
  },
  'lm-studio': {
    label: 'LM Studio',
    defaultProviderId: 'lm-studio',
    requireApiKey: false,
    requireBaseUrl: false,
    supportEmbedding: true,
    additionalSettings: [],
  },
  deepseek: {
    label: 'DeepSeek',
    defaultProviderId: 'deepseek',
    requireApiKey: true,
    requireBaseUrl: false,
    supportEmbedding: false,
    additionalSettings: [],
  },
  perplexity: {
    label: 'Perplexity',
    defaultProviderId: 'perplexity',
    requireApiKey: true,
    requireBaseUrl: false,
    supportEmbedding: false,
    additionalSettings: [],
  },
  mistral: {
    label: 'Mistral',
    defaultProviderId: 'mistral',
    requireApiKey: true,
    requireBaseUrl: false,
    supportEmbedding: false,
    additionalSettings: [],
  },
  morph: {
    label: 'Morph',
    defaultProviderId: 'morph',
    requireApiKey: true,
    requireBaseUrl: false,
    supportEmbedding: false,
    additionalSettings: [],
  },
  'azure-openai': {
    label: 'Azure OpenAI',
    defaultProviderId: null, // no default provider for this type
    requireApiKey: true,
    requireBaseUrl: true,
    supportEmbedding: false,
    additionalSettings: [
      {
        label: 'Deployment',
        key: 'deployment',
        placeholder: 'Enter your deployment name',
        type: 'text',
        required: true,
      },
      {
        label: 'API Version',
        key: 'apiVersion',
        placeholder: 'Enter your API version',
        type: 'text',
        required: true,
      },
    ],
  },
  'openai-compatible': {
    label: 'OpenAI Compatible',
    defaultProviderId: null, // no default provider for this type
    requireApiKey: false,
    requireBaseUrl: true,
    supportEmbedding: true,
    additionalSettings: [
      {
        label: 'No Stainless headers',
        key: 'noStainless',
        type: 'toggle',
        required: false,
        description:
          'Enable this if you encounter CORS errors related to Stainless headers (x-stainless-os, etc.)',
      },
    ],
  },
} as const satisfies Record<
  LLMProviderType,
  {
    label: string
    defaultProviderId: string | null
    requireApiKey: boolean
    requireBaseUrl: boolean
    supportEmbedding: boolean
    additionalSettings: {
      label: string
      key: string
      type: 'text' | 'toggle'
      placeholder?: string
      description?: string
      required?: boolean
    }[]
  }
>

/**
 * Important
 * 1. When adding new default provider, settings migration should be added
 * 2. If there's same provider id in user's settings, it's data should be overwritten by default provider
 */
export const DEFAULT_PROVIDERS: readonly LLMProvider[] = [
  {
    type: 'openai',
    id: PROVIDER_TYPES_INFO.openai.defaultProviderId,
  },
  {
    type: 'anthropic',
    id: PROVIDER_TYPES_INFO.anthropic.defaultProviderId,
  },
  {
    type: 'gemini',
    id: PROVIDER_TYPES_INFO.gemini.defaultProviderId,
  },
  {
    type: 'deepseek',
    id: PROVIDER_TYPES_INFO.deepseek.defaultProviderId,
  },
  {
    type: 'openrouter',
    id: PROVIDER_TYPES_INFO.openrouter.defaultProviderId,
  },
]

/**
 * Important
 * 1. When adding new default model, settings migration should be added
 * 2. If there's same model id in user's settings, it's data should be overwritten by default model
 */
export const DEFAULT_CHAT_MODELS: readonly ChatModel[] = [
  {
    providerType: 'anthropic',
    providerId: PROVIDER_TYPES_INFO.anthropic.defaultProviderId,
    id: 'anthropic/claude-sonnet-4.0',
    model: 'claude-sonnet-4-0',
    enable: false,
  },
  {
    providerType: 'anthropic',
    providerId: PROVIDER_TYPES_INFO.anthropic.defaultProviderId,
    id: 'anthropic/claude-opus-4.1',
    model: 'claude-opus-4-1',
    enable: false,
  },
  {
    providerType: 'anthropic',
    providerId: PROVIDER_TYPES_INFO.anthropic.defaultProviderId,
    id: 'anthropic/claude-3.7-sonnet',
    model: 'claude-3-7-sonnet-latest',
    enable: false,
  },
  {
    providerType: 'anthropic',
    providerId: PROVIDER_TYPES_INFO.anthropic.defaultProviderId,
    id: 'anthropic/claude-3.5-sonnet',
    model: 'claude-3-5-sonnet-latest',
    enable: false,
  },
  {
    providerType: 'anthropic',
    providerId: PROVIDER_TYPES_INFO.anthropic.defaultProviderId,
    id: 'anthropic/claude-3.5-haiku',
    model: 'claude-3-5-haiku-latest',
    enable: false,
  },
  {
    providerType: 'openai',
    providerId: PROVIDER_TYPES_INFO.openai.defaultProviderId,
    id: 'openai/gpt-5',
    model: 'gpt-5',
    enable: true,
  },
  {
    providerType: 'openai',
    providerId: PROVIDER_TYPES_INFO.openai.defaultProviderId,
    id: 'openai/gpt-5-mini',
    model: 'gpt-5-mini',
    enable: false,
  },
  {
    providerType: 'openai',
    providerId: PROVIDER_TYPES_INFO.openai.defaultProviderId,
    id: 'openai/gpt-5-nano',
    model: 'gpt-5-nano',
    enable: false,
  },
  {
    providerType: 'openai',
    providerId: PROVIDER_TYPES_INFO.openai.defaultProviderId,
    id: 'openai/gpt-4.1',
    model: 'gpt-4.1',
    enable: true,
  },
  {
    providerType: 'openai',
    providerId: PROVIDER_TYPES_INFO.openai.defaultProviderId,
    id: 'openai/gpt-4.1-mini',
    model: 'gpt-4.1-mini',
    enable: true,
  },
  {
    providerType: 'openai',
    providerId: PROVIDER_TYPES_INFO.openai.defaultProviderId,
    id: 'openai/gpt-4.1-nano',
    model: 'gpt-4.1-nano',
    enable: true,
  },
  {
    providerType: 'openai',
    providerId: PROVIDER_TYPES_INFO.openai.defaultProviderId,
    id: 'openai/gpt-4o',
    model: 'gpt-4o',
    enable: false,
  },
  {
    providerType: 'openai',
    providerId: PROVIDER_TYPES_INFO.openai.defaultProviderId,
    id: 'openai/gpt-4o-mini',
    model: 'gpt-4o-mini',
    enable: false,
  },
  {
    providerType: 'openai',
    providerId: PROVIDER_TYPES_INFO.openai.defaultProviderId,
    id: 'openai/o4-mini',
    model: 'o4-mini',
    enable: false,
    reasoning: {
      enabled: true,
      reasoning_effort: 'medium',
    },
  },
  {
    providerType: 'openai',
    providerId: PROVIDER_TYPES_INFO.openai.defaultProviderId,
    id: 'openai/o3',
    model: 'o3',
    enable: false,
    reasoning: {
      enabled: true,
      reasoning_effort: 'medium',
    },
  },
  {
    providerType: 'gemini',
    providerId: PROVIDER_TYPES_INFO.gemini.defaultProviderId,
    id: 'gemini/gemini-2.5-pro',
    model: 'gemini-2.5-pro',
    enable: false,
    thinking: {
      enabled: true,
      thinking_budget: -1,
    },
  },
  {
    providerType: 'gemini',
    providerId: PROVIDER_TYPES_INFO.gemini.defaultProviderId,
    id: 'gemini/gemini-2.5-flash',
    model: 'gemini-2.5-flash',
    enable: false,
    thinking: {
      enabled: true,
      thinking_budget: -1,
    },
  },
  {
    providerType: 'gemini',
    providerId: PROVIDER_TYPES_INFO.gemini.defaultProviderId,
    id: 'gemini/gemini-2.5-flash-lite',
    model: 'gemini-2.5-flash-lite',
    enable: false,
    thinking: {
      enabled: true,
      thinking_budget: -1,
    },
  },
  {
    providerType: 'gemini',
    providerId: PROVIDER_TYPES_INFO.gemini.defaultProviderId,
    id: 'gemini/gemini-2.0-flash',
    model: 'gemini-2.0-flash',
    enable: false,
    thinking: {
      enabled: true,
      thinking_budget: -1,
    },
  },
  {
    providerType: 'gemini',
    providerId: PROVIDER_TYPES_INFO.gemini.defaultProviderId,
    id: 'gemini/gemini-2.0-flash-lite',
    model: 'gemini-2.0-flash-lite',
    enable: false,
    thinking: {
      enabled: true,
      thinking_budget: -1,
    },
  },
  {
    providerType: 'deepseek',
    providerId: PROVIDER_TYPES_INFO.deepseek.defaultProviderId,
    id: 'deepseek/deepseek-chat',
    model: 'deepseek-chat',
    enable: false,
  },
  {
    providerType: 'deepseek',
    providerId: PROVIDER_TYPES_INFO.deepseek.defaultProviderId,
    id: 'deepseek/deepseek-reasoner',
    model: 'deepseek-reasoner',
    enable: false,
  },
]

/**
 * Important
 * 1. When adding new default embedding model, settings migration should be added
 * 2. If there's same embedding model id in user's settings, it's data should be overwritten by default embedding model
 */
export const DEFAULT_EMBEDDING_MODELS: readonly EmbeddingModel[] = [
  {
    providerType: 'openai',
    providerId: PROVIDER_TYPES_INFO.openai.defaultProviderId,
    id: 'openai/text-embedding-3-small',
    model: 'text-embedding-3-small',
    dimension: 1536,
  },
  {
    providerType: 'openai',
    providerId: PROVIDER_TYPES_INFO.openai.defaultProviderId,
    id: 'openai/text-embedding-3-large',
    model: 'text-embedding-3-large',
    dimension: 3072,
  },
  {
    providerType: 'gemini',
    providerId: PROVIDER_TYPES_INFO.gemini.defaultProviderId,
    id: 'gemini/text-embedding-004',
    model: 'text-embedding-004',
    dimension: 768,
  },
]

// Pricing in dollars per million tokens
type ModelPricing = {
  input: number
  output: number
}

export const OPENAI_PRICES: Record<string, ModelPricing> = {
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  o3: { input: 10, output: 40 },
  o1: { input: 15, output: 60 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o1-mini': { input: 1.1, output: 4.4 },
}

export const ANTHROPIC_PRICES: Record<string, ModelPricing> = {
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4-0': { input: 15, output: 75 },
  'claude-sonnet-4-0': { input: 3, output: 15 },
  'claude-3-5-sonnet-latest': { input: 3, output: 15 },
  'claude-3-7-sonnet-latest': { input: 3, output: 15 },
  'claude-3-5-haiku-latest': { input: 1, output: 5 },
}

// Gemini is currently free for low rate limits
export const GEMINI_PRICES: Record<string, ModelPricing> = {}
