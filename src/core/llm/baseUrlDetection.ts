import { DeepSeekMessageAdapter } from './deepseekMessageAdapter'
import { KimiMessageAdapter } from './kimiMessageAdapter'
import { MistralMessageAdapter } from './mistralMessageAdapter'
import { OpenAIMessageAdapter } from './openaiMessageAdapter'
import { PerplexityMessageAdapter } from './perplexityMessageAdapter'
import { ReasoningContentMessageAdapter } from './reasoningContentMessageAdapter'

/**
 * Detects DeepSeek-compatible gateways by base URL. DeepSeek's thinking mode
 * returns responses with a non-standard `reasoning_content` field and requires
 * that field to be echoed back on assistant tool-call messages. Generic
 * OpenAIMessageAdapter neither reads nor forwards it, so when users configure
 * DeepSeek via the generic `openai-compatible` preset we silently swap in the
 * DeepSeek-aware adapter to keep multi-turn tool calls working.
 */
export const isDeepSeekBaseUrl = (baseUrl: string | undefined): boolean => {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'api.deepseek.com' || host.endsWith('.deepseek.com')
  } catch {
    return /(?:^|[./])deepseek\.com(?:[:/]|$)/i.test(baseUrl)
  }
}

/**
 * Detects Moonshot/Kimi gateways by base URL. Kimi's thinking models require
 * `reasoning_content` on assistant tool-call messages (similar to DeepSeek) and
 * reject empty-string `content` on tool-call messages. Without the KimiMessageAdapter,
 * multi-turn tool calls with thinking models fail with 400 errors.
 */
export const isMoonshotBaseUrl = (baseUrl: string | undefined): boolean => {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'api.moonshot.cn' || host.endsWith('.moonshot.cn')
  } catch {
    return /(?:^|[./])moonshot\.cn(?:[:/]|$)/i.test(baseUrl)
  }
}

/**
 * Detects Mistral gateways by base URL. Mistral's API does not support the
 * `stream_options` parameter; including it causes streaming requests to fail.
 * The MistralMessageAdapter omits this field to prevent errors.
 */
export const isMistralBaseUrl = (baseUrl: string | undefined): boolean => {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'api.mistral.ai' || host.endsWith('.mistral.ai')
  } catch {
    return /(?:^|[./])mistral\.ai(?:[:/]|$)/i.test(baseUrl)
  }
}

/**
 * Detects Perplexity gateways by base URL. Perplexity returns citations in a
 * non-standard top-level `citations` array. The PerplexityMessageAdapter maps
 * these into the unified `annotations` format so the UI can display sources.
 */
export const isPerplexityBaseUrl = (baseUrl: string | undefined): boolean => {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'api.perplexity.ai' || host.endsWith('.perplexity.ai')
  } catch {
    return /(?:^|[./])perplexity\.ai(?:[:/]|$)/i.test(baseUrl)
  }
}

const REASONING_CONTENT_DOMAINS = [
  'bigmodel.cn', // GLM
  'z.ai', // GLM
  'dashscope.aliyuncs.com', // Qwen
  'dashscope-intl.aliyuncs.com', // Qwen
  'siliconflow.cn',
  'siliconflow.com',
]

/**
 * Detects gateways that take reasoning back as `reasoning_content` on
 * assistant messages, so reasoning stays continuous across tool calls.
 */
export const isReasoningContentBaseUrl = (
  baseUrl: string | undefined,
): boolean => {
  if (!baseUrl) return false
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return REASONING_CONTENT_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  )
}

/**
 * Resolves the appropriate MessageAdapter based on the base URL. Used by
 * `OpenAICompatibleProvider` when no explicit adapter is passed via the
 * constructor `options.adapter` parameter. This allows users who configure
 * providers via the generic `openai-compatible` preset to still get correct
 * behavior for known services.
 */
export const resolveAdapterForBaseUrl = (
  baseUrl: string | undefined,
): OpenAIMessageAdapter => {
  if (isDeepSeekBaseUrl(baseUrl)) return new DeepSeekMessageAdapter()
  if (isMoonshotBaseUrl(baseUrl)) return new KimiMessageAdapter()
  if (isMistralBaseUrl(baseUrl)) return new MistralMessageAdapter()
  if (isPerplexityBaseUrl(baseUrl)) return new PerplexityMessageAdapter()
  if (isReasoningContentBaseUrl(baseUrl))
    return new ReasoningContentMessageAdapter()
  return new OpenAIMessageAdapter()
}
