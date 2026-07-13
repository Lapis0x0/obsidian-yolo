import amazonBedrockLogo from '../assets/provider-icons/amazon-bedrock.svg'
import anthropicLogo from '../assets/provider-icons/anthropic.svg'
import azureOpenaiLogo from '../assets/provider-icons/azure-openai.svg'
import cerebrasLogo from '../assets/provider-icons/cerebras.svg'
import deepseekLogo from '../assets/provider-icons/deepseek.svg'
import doubaoLogo from '../assets/provider-icons/doubao.svg'
import geminiLogo from '../assets/provider-icons/gemini.svg'
import groqLogo from '../assets/provider-icons/groq.svg'
import hunyuanLogo from '../assets/provider-icons/hunyuan.svg'
import lmStudioLogo from '../assets/provider-icons/lm-studio.svg'
import minimaxLogo from '../assets/provider-icons/minimax.svg'
import mistralLogo from '../assets/provider-icons/mistral.svg'
import moonshotLogo from '../assets/provider-icons/moonshot.svg'
import morphLogo from '../assets/provider-icons/morph.svg'
import ollamaLogo from '../assets/provider-icons/ollama.svg'
import openaiLogo from '../assets/provider-icons/openai.svg'
import openrouterLogo from '../assets/provider-icons/openrouter.svg'
import perplexityLogo from '../assets/provider-icons/perplexity.svg'
import sambanovaLogo from '../assets/provider-icons/sambanova.svg'
import siliconflowLogo from '../assets/provider-icons/siliconflow.svg'
import stepfunLogo from '../assets/provider-icons/stepfun.svg'
import togetherAiLogo from '../assets/provider-icons/together-ai.svg'
import xaiLogo from '../assets/provider-icons/xai.svg'
import xiaomimimoLogo from '../assets/provider-icons/xiaomimimo.svg'
import zhipuLogo from '../assets/provider-icons/zhipu.svg'
import { LLMProviderPresetType } from '../types/provider.types'

// Picker categories from the V1-grid design. `custom` is rendered as a
// dedicated last tile, not as part of any category list.
export type ProviderPickerCategory = 'main' | 'cn' | 'gw' | 'cloud' | 'local'

export type ProviderTint =
  | 'blue'
  | 'indigo'
  | 'purple'
  | 'rose'
  | 'amber'
  | 'orange'
  | 'teal'
  | 'green'
  | 'pink'
  | 'slate'
  | 'ink'

export type ProviderCatalogEntry = {
  /** Used when `logo` is undefined or the user prefers monogram mode. */
  monogram: string
  /** Drives the monogram tile colour AND the subtle ring on logo tiles. */
  tint: ProviderTint
  category: ProviderPickerCategory
  /** OAuth flow rather than API-key auth — surfaced as a badge. */
  oauth?: boolean
  /** Inlined brand logo (data-URL via esbuild). Falls back to monogram. */
  logo?: string
}

// Keyed by `LLMProviderPresetType`, minus `openai-compatible` which is rendered
// as the dedicated "custom" tile. Using `Record<Exclude<...>>` forces TS to
// surface any new preset that has not been catalogued here.
export const PROVIDER_CATALOG: Record<
  Exclude<LLMProviderPresetType, 'openai-compatible'>,
  ProviderCatalogEntry
> = {
  openai: {
    monogram: 'OA',
    tint: 'green',
    category: 'main',
    logo: openaiLogo,
  },
  'chatgpt-oauth': {
    monogram: 'GPT',
    tint: 'green',
    category: 'main',
    oauth: true,
    logo: openaiLogo,
  },
  anthropic: {
    monogram: 'An',
    tint: 'amber',
    category: 'main',
    logo: anthropicLogo,
  },
  gemini: {
    monogram: 'Ge',
    tint: 'teal',
    category: 'main',
    logo: geminiLogo,
  },
  'gemini-oauth': {
    monogram: 'Ge',
    tint: 'teal',
    category: 'main',
    oauth: true,
    logo: geminiLogo,
  },
  mistral: {
    monogram: 'Mi',
    tint: 'rose',
    category: 'main',
    logo: mistralLogo,
  },
  perplexity: {
    monogram: 'Px',
    tint: 'teal',
    category: 'main',
    logo: perplexityLogo,
  },
  groq: {
    monogram: 'Gq',
    tint: 'orange',
    category: 'main',
    logo: groqLogo,
  },
  morph: {
    monogram: 'Mo',
    tint: 'pink',
    category: 'main',
    logo: morphLogo,
  },
  deepseek: {
    monogram: '深度',
    tint: 'blue',
    category: 'cn',
    logo: deepseekLogo,
  },
  moonshot: {
    monogram: 'Ki',
    tint: 'purple',
    category: 'cn',
    logo: moonshotLogo,
  },
  openrouter: {
    monogram: 'OR',
    tint: 'purple',
    category: 'gw',
    logo: openrouterLogo,
  },
  'azure-openai': {
    monogram: 'Az',
    tint: 'blue',
    category: 'cloud',
    logo: azureOpenaiLogo,
  },
  'amazon-bedrock': {
    monogram: 'Br',
    tint: 'amber',
    category: 'cloud',
    logo: amazonBedrockLogo,
  },
  ollama: {
    monogram: 'Ol',
    tint: 'slate',
    category: 'local',
    logo: ollamaLogo,
  },
  'lm-studio': {
    monogram: 'LM',
    tint: 'slate',
    category: 'local',
    logo: lmStudioLogo,
  },
  zhipu: {
    monogram: '智谱',
    tint: 'indigo',
    category: 'cn',
    logo: zhipuLogo,
  },
  doubao: {
    monogram: '豆包',
    tint: 'rose',
    category: 'cn',
    logo: doubaoLogo,
  },
  siliconflow: {
    monogram: '硅基',
    tint: 'blue',
    category: 'cn',
    logo: siliconflowLogo,
  },
  stepfun: {
    monogram: '阶跃',
    tint: 'purple',
    category: 'cn',
    logo: stepfunLogo,
  },
  minimax: {
    monogram: 'MM',
    tint: 'pink',
    category: 'cn',
    logo: minimaxLogo,
  },
  hunyuan: {
    monogram: '混元',
    tint: 'teal',
    category: 'cn',
    logo: hunyuanLogo,
  },
  xiaomimimo: {
    monogram: 'MiMo',
    tint: 'orange',
    category: 'cn',
    logo: xiaomimimoLogo,
  },
  xai: {
    monogram: 'xAI',
    tint: 'ink',
    category: 'main',
    logo: xaiLogo,
  },
  'together-ai': {
    monogram: 'Tg',
    tint: 'indigo',
    category: 'main',
    logo: togetherAiLogo,
  },
  cerebras: {
    monogram: 'Cb',
    tint: 'orange',
    category: 'main',
    logo: cerebrasLogo,
  },
  sambanova: {
    monogram: 'SN',
    tint: 'rose',
    category: 'main',
    logo: sambanovaLogo,
  },
}

// Sort order inside each category (and across the flat list when category=all).
// Matches the visual priority in the design (mainstream first, then CN, etc.).
const FLAT_ORDER: Exclude<LLMProviderPresetType, 'openai-compatible'>[] = [
  // International (main)
  'openai',
  'chatgpt-oauth',
  'anthropic',
  'gemini',
  'gemini-oauth',
  'xai',
  'mistral',
  'perplexity',
  'groq',
  'cerebras',
  'sambanova',
  'together-ai',
  'morph',
  // China (cn)
  'deepseek',
  'moonshot',
  'zhipu',
  'doubao',
  'siliconflow',
  'stepfun',
  'minimax',
  'hunyuan',
  'xiaomimimo',
  // Gateway
  'openrouter',
  // Cloud
  'azure-openai',
  'amazon-bedrock',
  // Local
  'ollama',
  'lm-studio',
]

export const PROVIDER_PICKER_ORDER = FLAT_ORDER

export const PROVIDER_PICKER_CATEGORIES: {
  id: 'all' | ProviderPickerCategory
  labelKey: string
  fallback: string
}[] = [
  { id: 'all', labelKey: 'categoryAll', fallback: 'All' },
  { id: 'main', labelKey: 'categoryMain', fallback: 'International' },
  { id: 'cn', labelKey: 'categoryCn', fallback: 'China' },
  { id: 'gw', labelKey: 'categoryGateway', fallback: 'Gateway' },
  { id: 'cloud', labelKey: 'categoryCloud', fallback: 'Cloud' },
  { id: 'local', labelKey: 'categoryLocal', fallback: 'Local' },
]
