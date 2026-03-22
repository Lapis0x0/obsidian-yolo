import { z } from 'zod'

import { customParameterSchema } from './custom-parameter.types'
export const reasoningConfigSchema = z
  .object({
    enabled: z.boolean(),
    reasoning_effort: z.string().optional(),
  })
  .optional()

export const thinkingConfigSchema = z
  .object({
    enabled: z.boolean(),
    budget_tokens: z.number().optional(),
    // Google Gemini thinking tokens budget. 0=off (Flash/Flash-Lite), -1=dynamic.
    thinking_budget: z.number().optional(),
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
  reasoningType: z
    .enum(['none', 'openai', 'gemini', 'anthropic', 'generic'])
    .optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().min(1).optional(),
  customParameters: z.array(customParameterSchema).optional(),
  reasoning: reasoningConfigSchema,
  thinking: thinkingConfigSchema,
  toolType: z.enum(['none', 'gemini']).default('none').optional(),
  web_search_options: z
    .object({
      search_context_size: z.string(),
    })
    .optional(),
})

export type ChatModel = z.infer<typeof chatModelSchema>
