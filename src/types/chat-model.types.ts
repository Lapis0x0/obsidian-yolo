import { z } from 'zod'

import { customParameterSchema } from './custom-parameter.types'

export const CHAT_MODEL_MODALITIES = ['text', 'vision', 'pdf'] as const
export const chatModelModalitySchema = z.enum(CHAT_MODEL_MODALITIES)
export type ChatModelModality = z.infer<typeof chatModelModalitySchema>

const webSearchToggleSchema = z
  .object({
    webSearch: z
      .object({
        enabled: z.boolean(),
      })
      .optional(),
  })
  .optional()

// OpenRouter hosted web search
// (https://openrouter.ai/docs/guides/features/server-tools/web-search). Five
// engines are supported: `auto` (default — native if available, else Exa),
// `native` (model provider's built-in search), `exa`, `firecrawl` (BYOK in
// the OpenRouter dashboard), and `parallel`.
const openRouterWebSearchToggleSchema = z
  .object({
    webSearch: z
      .object({
        enabled: z.boolean(),
        engine: z
          .enum(['auto', 'native', 'exa', 'firecrawl', 'parallel'])
          .optional(),
        maxResults: z.number().int().min(1).max(25).optional(),
      })
      .optional(),
  })
  .optional()

/**
 * Built-in (a.k.a. hosted / server-side) tools provided by the model provider
 * itself — not function-calling tools the agent runs. They share the same
 * `tools` / `extra_body` slot in the request payload depending on the
 * provider, and use provider-specific shapes (e.g. `{type:"web_search"}` for
 * OpenAI, `{type:"openrouter:web_search"}` for OpenRouter, xAI Grok
 * `search_parameters`).
 * Configure which provider's built-in tools to enable via `builtinToolProvider`,
 * and per-provider toggles via the matching sub-key.
 *
 * Provider–family alignment is now the user's responsibility: any model can
 * point at any family (e.g. a non-OpenRouter gateway with OpenRouter tools),
 * and downstream provider clients only forward families they understand —
 * mismatches are silently ignored rather than rewritten to avoid changing user
 * intent.
 */
// Gemini's native tool family is broader than just web search — `urlContext`
// fetches content from URLs the user references. Both surface as separate
// `googleSearch` / `urlContext` entries in Gemini's `tools` array (or as
// synthetic function tools on openai-compatible gateways).
const geminiBuiltinToolsSchema = z
  .object({
    webSearch: z.object({ enabled: z.boolean() }).optional(),
    urlContext: z.object({ enabled: z.boolean() }).optional(),
  })
  .optional()

export const builtinToolsConfigSchema = z
  .object({
    gpt: webSearchToggleSchema,
    openrouter: openRouterWebSearchToggleSchema,
    grok: webSearchToggleSchema,
    gemini: geminiBuiltinToolsSchema,
    deepseek: webSearchToggleSchema,
  })
  .optional()

export const chatModelSchema = z.object({
  providerId: z
    .string({
      required_error: 'provider ID is required',
    })
    .min(1, 'provider ID is required'),
  id: z
    .string({
      required_error: 'id is required',
    })
    .min(1, 'id is required'),
  model: z
    .string({
      required_error: 'model is required',
    })
    .min(1, 'model is required'),
  // Optional display name for UI. When absent, UI should fallback to showing `model`.
  name: z.string().optional(),
  enable: z.boolean().default(true).optional(),
  reasoningType: z.enum(['none', 'openai', 'gemini', 'anthropic']).optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxContextTokens: z.number().int().min(1).optional(),
  maxOutputTokens: z.number().int().min(1).optional(),
  customParameters: z.array(customParameterSchema).optional(),
  modalities: z.array(chatModelModalitySchema).optional(),
  // Which provider's built-in (hosted) tools to enable on this model.
  // 'gemini' / 'gpt' / 'openrouter' map to the provider-native tool family in
  // the request body. See `builtinTools` for per-family toggles.
  builtinToolProvider: z
    .enum(['none', 'gemini', 'gpt', 'openrouter', 'grok', 'deepseek'])
    .default('none')
    .optional(),
  builtinTools: builtinToolsConfigSchema,
  web_search_options: z
    .object({
      search_context_size: z.string(),
    })
    .optional(),
})

export type ChatModel = z.infer<typeof chatModelSchema>
