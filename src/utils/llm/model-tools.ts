import { ChatModel } from '../../types/chat-model.types'
import { LLMProviderApiType } from '../../types/provider.types'

/**
 * Provider built-in (hosted / server-side) tools. These are executed on the
 * model provider's side and share the same request payload as function-calling
 * tools — but use provider-specific shapes. We carry them through the pipeline
 * as a small internal tagged union; each provider client picks out the family
 * it knows how to forward and ignores the rest.
 *
 * - `web_search`: OpenAI-style hosted web search. OpenAI-compatible gateways
 *   forward as `extra_body.tools=[{type:"web_search"}]`; OpenAI Responses maps
 *   to `tools=[{type:"web_search_preview"}]`.
 * - `openrouter:web_search`: OpenRouter's hosted web search. Carries optional
 *   `engine` (auto/native/exa/firecrawl/parallel) and `maxResults` (1–25),
 *   which the OpenRouter provider serializes to the server-tool entry
 *   `tools=[{type:"openrouter:web_search", parameters:{engine?, max_results?}}]`.
 * - `grok:live_search`: xAI Live Search. Serialized as
 *   `extra_body.search_parameters={mode:"auto", return_citations:true}` on the
 *   chat-completions endpoint.
 * - `gemini:web_search`: Gemini Google Search grounding. On the native Gemini
 *   transport it becomes `tools=[{googleSearch:{}}]`; on openai-compatible
 *   gateways (Vertex etc.) it becomes a synthetic `googleSearch` function tool.
 * - `gemini:url_context`: Gemini URL Context. On native Gemini becomes
 *   `tools=[{urlContext:{}}]`; on openai-compatible gateways it becomes a
 *   synthetic `urlContext` function tool.
 * - `deepseek:web_search`: DeepSeek's server-side web search. DeepSeek exposes
 *   it on two transports with different shapes, so the family stays abstract
 *   here and each client serializes its own: the Anthropic transport emits
 *   `tools=[{type:"web_search_20250305", name:"web_search"}]`, the Responses
 *   transport emits `tools=[{type:"web_search"}]`. It is NOT available on
 *   `chat/completions` — DeepSeek rejects hosted tool types there.
 */
export type BuiltinProviderTool =
  | { type: 'web_search' }
  | {
      type: 'openrouter:web_search'
      engine?: 'auto' | 'native' | 'exa' | 'firecrawl' | 'parallel'
      maxResults?: number
    }
  | { type: 'grok:live_search' }
  | { type: 'gemini:web_search' }
  | { type: 'gemini:url_context' }
  | { type: 'deepseek:web_search' }

export function getBuiltinProviderTools(
  model: Pick<ChatModel, 'builtinToolProvider' | 'builtinTools'>,
): BuiltinProviderTool[] {
  switch (model.builtinToolProvider) {
    case 'gpt': {
      if (model.builtinTools?.gpt?.webSearch?.enabled) {
        return [{ type: 'web_search' }]
      }
      return []
    }
    case 'openrouter': {
      const cfg = model.builtinTools?.openrouter?.webSearch
      if (cfg?.enabled) {
        const tool: Extract<
          BuiltinProviderTool,
          { type: 'openrouter:web_search' }
        > = { type: 'openrouter:web_search' }
        // `auto` is the OpenRouter default — encode by omitting the field.
        if (cfg.engine && cfg.engine !== 'auto') {
          tool.engine = cfg.engine
        }
        if (typeof cfg.maxResults === 'number') {
          tool.maxResults = cfg.maxResults
        }
        return [tool]
      }
      return []
    }
    case 'grok': {
      if (model.builtinTools?.grok?.webSearch?.enabled) {
        return [{ type: 'grok:live_search' }]
      }
      return []
    }
    case 'deepseek': {
      if (model.builtinTools?.deepseek?.webSearch?.enabled) {
        return [{ type: 'deepseek:web_search' }]
      }
      return []
    }
    case 'gemini': {
      const tools: BuiltinProviderTool[] = []
      if (model.builtinTools?.gemini?.webSearch?.enabled) {
        tools.push({ type: 'gemini:web_search' })
      }
      if (model.builtinTools?.gemini?.urlContext?.enabled) {
        tools.push({ type: 'gemini:url_context' })
      }
      return tools
    }
    default:
      return []
  }
}

/**
 * Transports on which DeepSeek actually serves its hosted web search.
 * `chat/completions` rejects hosted tool types, so a model configured for it
 * gets nothing regardless of the toggle.
 */
const HOSTED_WEB_SEARCH_API_TYPES: readonly LLMProviderApiType[] = [
  'anthropic',
  'openai-responses',
]

/**
 * Whether this turn will carry a provider-run web search. The agent uses this
 * to stop offering its own `web_search` — otherwise the model sees two
 * interchangeable search tools and routinely burns a turn on the first one.
 *
 * The api-type guard matters: leaving the toggle on and switching the provider
 * back to `openai-compatible` would otherwise drop our search without the
 * provider's ever replacing it.
 */
export function hasHostedWebSearch(
  model: Pick<ChatModel, 'builtinToolProvider' | 'builtinTools'>,
  apiType: LLMProviderApiType | null | undefined,
): boolean {
  if (!apiType || !HOSTED_WEB_SEARCH_API_TYPES.includes(apiType)) {
    return false
  }
  return getBuiltinProviderTools(model).some(
    (tool) => tool.type === 'deepseek:web_search',
  )
}
