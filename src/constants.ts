import { ChatModel } from './types/chat-model.types'
import { EmbeddingModel } from './types/embedding-model.types'
import {
  LLMProvider,
  LLMProviderApiType,
  LLMProviderPresetType,
  getDefaultApiTypeForPresetType,
} from './types/provider.types'

export const CHAT_VIEW_TYPE = 'smtcmp-chat-view'

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
  en: "You are a title generator. Generate a concise conversation title based on the first user message and the assistant's first completed reply. Output the title only.",
  zh: '你是一个标题生成器。请基于第一轮对话（用户首条消息与助手首个完整回复）生成一个简洁的会话标题，直接输出标题本身。',
  it: "Sei un generatore di titoli. Genera un titolo di conversazione conciso in base al primo messaggio dell'utente e alla prima risposta completa dell'assistente. Restituisci solo il titolo.",
} as const

export const PROVIDER_PRESET_INFO = {
  openai: {
    label: 'OpenAI',
    defaultProviderId: 'openai',
    requireApiKey: true,
    requireBaseUrl: false,
    supportEmbedding: true,
    additionalSettings: [],
  },
  'chatgpt-oauth': {
    label: 'ChatGPT OAuth',
    defaultProviderId: 'chatgpt-oauth',
    requireApiKey: false,
    requireBaseUrl: false,
    supportEmbedding: false,
    additionalSettings: [],
  },
  anthropic: {
    label: 'Anthropic',
    defaultProviderId: 'anthropic',
    requireApiKey: true,
    requireBaseUrl: false,
    supportEmbedding: false,
    additionalSettings: [
      {
        label: 'Request transport mode',
        key: 'requestTransportMode',
        type: 'select',
        required: false,
        options: {
          auto: 'Auto',
          browser: 'Browser fetch',
          obsidian: 'Obsidian requestUrl',
        },
        description:
          'Auto: try browser fetch first and fallback to Obsidian requestUrl on CORS/network errors. Obsidian mode buffers streaming responses.',
      },
    ],
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
      {
        label: 'Request transport mode',
        key: 'requestTransportMode',
        type: 'select',
        required: false,
        options: {
          auto: 'Auto',
          browser: 'Browser fetch',
          obsidian: 'Obsidian requestUrl',
        },
        description:
          'Auto: try browser fetch first and fallback to Obsidian requestUrl on CORS/network errors. Obsidian mode buffers streaming responses.',
      },
    ],
  },
} as const satisfies Record<
  LLMProviderPresetType,
  {
    label: string
    defaultProviderId: string | null
    requireApiKey: boolean
    requireBaseUrl: boolean
    supportEmbedding: boolean
    additionalSettings: {
      label: string
      key: string
      type: 'text' | 'toggle' | 'select'
      options?: Record<string, string>
      placeholder?: string
      description?: string
      required?: boolean
    }[]
  }
>

export const PROVIDER_API_INFO: Record<
  LLMProviderApiType,
  {
    label: string
  }
> = {
  'openai-compatible': {
    label: 'OpenAI Compatible',
  },
  'openai-responses': {
    label: 'OpenAI Responses',
  },
  anthropic: {
    label: 'Anthropic API',
  },
  gemini: {
    label: 'Gemini API',
  },
}

export const PROVIDER_TYPES_INFO = PROVIDER_PRESET_INFO

/**
 * Important
 * 1. When adding new default provider, settings migration should be added
 * 2. If there's same provider id in user's settings, it's data should be overwritten by default provider
 */
export const DEFAULT_PROVIDERS: readonly LLMProvider[] = [
  {
    presetType: 'openai',
    apiType: getDefaultApiTypeForPresetType('openai'),
    id: PROVIDER_PRESET_INFO.openai.defaultProviderId,
  },
  {
    presetType: 'chatgpt-oauth',
    apiType: getDefaultApiTypeForPresetType('chatgpt-oauth'),
    id: PROVIDER_PRESET_INFO['chatgpt-oauth'].defaultProviderId,
  },
  {
    presetType: 'anthropic',
    apiType: getDefaultApiTypeForPresetType('anthropic'),
    id: PROVIDER_PRESET_INFO.anthropic.defaultProviderId,
  },
  {
    presetType: 'gemini',
    apiType: getDefaultApiTypeForPresetType('gemini'),
    id: PROVIDER_PRESET_INFO.gemini.defaultProviderId,
  },
  {
    presetType: 'deepseek',
    apiType: getDefaultApiTypeForPresetType('deepseek'),
    id: PROVIDER_PRESET_INFO.deepseek.defaultProviderId,
  },
  {
    presetType: 'openrouter',
    apiType: getDefaultApiTypeForPresetType('openrouter'),
    id: PROVIDER_PRESET_INFO.openrouter.defaultProviderId,
  },
]

/**
 * Important
 * 1. When adding new default model, settings migration should be added
 * 2. If there's same model id in user's settings, it's data should be overwritten by default model
 */
export const DEFAULT_CHAT_MODELS: readonly ChatModel[] = [
  {
    providerId: PROVIDER_PRESET_INFO.anthropic.defaultProviderId,
    id: 'anthropic/claude-sonnet-4.0',
    model: 'claude-sonnet-4-0',
    enable: false,
  },
  {
    providerId: PROVIDER_PRESET_INFO.anthropic.defaultProviderId,
    id: 'anthropic/claude-opus-4.1',
    model: 'claude-opus-4-1',
    enable: false,
  },
  {
    providerId: PROVIDER_PRESET_INFO.anthropic.defaultProviderId,
    id: 'anthropic/claude-3.7-sonnet',
    model: 'claude-3-7-sonnet-latest',
    enable: false,
  },
  {
    providerId: PROVIDER_PRESET_INFO.anthropic.defaultProviderId,
    id: 'anthropic/claude-3.5-sonnet',
    model: 'claude-3-5-sonnet-latest',
    enable: false,
  },
  {
    providerId: PROVIDER_PRESET_INFO.anthropic.defaultProviderId,
    id: 'anthropic/claude-3.5-haiku',
    model: 'claude-3-5-haiku-latest',
    enable: false,
  },
  {
    providerId: PROVIDER_PRESET_INFO.openai.defaultProviderId,
    id: 'openai/gpt-5',
    model: 'gpt-5',
    enable: true,
  },
  {
    providerId: PROVIDER_PRESET_INFO['chatgpt-oauth'].defaultProviderId,
    id: 'chatgpt-oauth/gpt-5.3-codex',
    model: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    enable: false,
    reasoning: {
      enabled: true,
      reasoning_effort: 'medium',
    },
  },
  {
    providerId: PROVIDER_PRESET_INFO['chatgpt-oauth'].defaultProviderId,
    id: 'chatgpt-oauth/gpt-5.4',
    model: 'gpt-5.4',
    name: 'GPT-5.4',
    enable: false,
    reasoning: {
      enabled: true,
      reasoning_effort: 'medium',
    },
  },
  {
    providerId: PROVIDER_PRESET_INFO.openai.defaultProviderId,
    id: 'openai/gpt-5-mini',
    model: 'gpt-5-mini',
    enable: false,
  },
  {
    providerId: PROVIDER_PRESET_INFO.openai.defaultProviderId,
    id: 'openai/gpt-5-nano',
    model: 'gpt-5-nano',
    enable: false,
  },
  {
    providerId: PROVIDER_PRESET_INFO.openai.defaultProviderId,
    id: 'openai/gpt-4.1',
    model: 'gpt-4.1',
    enable: true,
  },
  {
    providerId: PROVIDER_PRESET_INFO.openai.defaultProviderId,
    id: 'openai/gpt-4.1-mini',
    model: 'gpt-4.1-mini',
    enable: true,
  },
  {
    providerId: PROVIDER_PRESET_INFO.openai.defaultProviderId,
    id: 'openai/gpt-4.1-nano',
    model: 'gpt-4.1-nano',
    enable: true,
  },
  {
    providerId: PROVIDER_PRESET_INFO.openai.defaultProviderId,
    id: 'openai/gpt-4o',
    model: 'gpt-4o',
    enable: false,
  },
  {
    providerId: PROVIDER_PRESET_INFO.openai.defaultProviderId,
    id: 'openai/gpt-4o-mini',
    model: 'gpt-4o-mini',
    enable: false,
  },
  {
    providerId: PROVIDER_PRESET_INFO.openai.defaultProviderId,
    id: 'openai/o4-mini',
    model: 'o4-mini',
    enable: false,
    reasoning: {
      enabled: true,
      reasoning_effort: 'medium',
    },
  },
  {
    providerId: PROVIDER_PRESET_INFO.openai.defaultProviderId,
    id: 'openai/o3',
    model: 'o3',
    enable: false,
    reasoning: {
      enabled: true,
      reasoning_effort: 'medium',
    },
  },
  {
    providerId: PROVIDER_PRESET_INFO.gemini.defaultProviderId,
    id: 'gemini/gemini-2.5-pro',
    model: 'gemini-2.5-pro',
    enable: false,
    thinking: {
      enabled: true,
      thinking_budget: -1,
    },
  },
  {
    providerId: PROVIDER_PRESET_INFO.gemini.defaultProviderId,
    id: 'gemini/gemini-2.5-flash',
    model: 'gemini-2.5-flash',
    enable: false,
    thinking: {
      enabled: true,
      thinking_budget: -1,
    },
  },
  {
    providerId: PROVIDER_PRESET_INFO.gemini.defaultProviderId,
    id: 'gemini/gemini-2.5-flash-lite',
    model: 'gemini-2.5-flash-lite',
    enable: false,
    thinking: {
      enabled: true,
      thinking_budget: -1,
    },
  },
  {
    providerId: PROVIDER_PRESET_INFO.gemini.defaultProviderId,
    id: 'gemini/gemini-2.0-flash',
    model: 'gemini-2.0-flash',
    enable: false,
    thinking: {
      enabled: true,
      thinking_budget: -1,
    },
  },
  {
    providerId: PROVIDER_PRESET_INFO.gemini.defaultProviderId,
    id: 'gemini/gemini-2.0-flash-lite',
    model: 'gemini-2.0-flash-lite',
    enable: false,
    thinking: {
      enabled: true,
      thinking_budget: -1,
    },
  },
  {
    providerId: PROVIDER_PRESET_INFO.deepseek.defaultProviderId,
    id: 'deepseek/deepseek-chat',
    model: 'deepseek-chat',
    enable: false,
  },
  {
    providerId: PROVIDER_PRESET_INFO.deepseek.defaultProviderId,
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
    providerId: PROVIDER_PRESET_INFO.openai.defaultProviderId,
    id: 'openai/text-embedding-3-small',
    model: 'text-embedding-3-small',
    dimension: 1536,
  },
  {
    providerId: PROVIDER_PRESET_INFO.openai.defaultProviderId,
    id: 'openai/text-embedding-3-large',
    model: 'text-embedding-3-large',
    dimension: 3072,
  },
  {
    providerId: PROVIDER_PRESET_INFO.gemini.defaultProviderId,
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
