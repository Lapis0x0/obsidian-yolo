import { z } from 'zod'

import { customParameterSchema } from './custom-parameter.types'

export const gptToolsConfigSchema = z
  .object({
    webSearch: z
      .object({
        enabled: z.boolean(),
      })
      .optional(),
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
  toolType: z.enum(['none', 'gemini', 'gpt']).default('none').optional(),
  gptTools: gptToolsConfigSchema,
  web_search_options: z
    .object({
      search_context_size: z.string(),
    })
    .optional(),
})

export type ChatModel = z.infer<typeof chatModelSchema>
