import { z } from 'zod'

const baseChatModelSchema = z.object({
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
  isBaseModel: z.boolean().default(false).optional(),
  reasoningType: z
    .enum(['none', 'openai', 'gemini', 'anthropic', 'generic'])
    .optional(),
  customParameters: z
    .array(
      z.object({
        key: z
          .string({
            required_error: 'custom parameter key is required',
          })
          .min(1, 'custom parameter key is required'),
        value: z.string().default(''),
      }),
    )
    .optional(),
})

export const chatModelSchema = z.discriminatedUnion('providerType', [
  z.object({
    providerType: z.literal('openai'),
    ...baseChatModelSchema.shape,
    reasoning: z
      .object({
        enabled: z.boolean(),
        reasoning_effort: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    providerType: z.literal('anthropic'),
    ...baseChatModelSchema.shape,
    thinking: z
      .object({
        enabled: z.boolean(),
        budget_tokens: z.number(),
      })
      .optional(),
  }),
  z.object({
    providerType: z.literal('gemini'),
    ...baseChatModelSchema.shape,
    thinking: z
      .object({
        enabled: z.boolean(),
        // Google Gemini thinking tokens budget. 0=off (Flash/Flash-Lite), -1=dynamic.
        thinking_budget: z.number(),
      })
      .default({ enabled: true, thinking_budget: -1 })
      .optional(),
    toolType: z.enum(['none', 'gemini']).default('none').optional(),
  }),
  z.object({
    providerType: z.literal('groq'),
    ...baseChatModelSchema.shape,
  }),
  z.object({
    providerType: z.literal('openrouter'),
    ...baseChatModelSchema.shape,
    // Allow users to configure reasoning/thinking even via aggregators
    reasoning: z
      .object({
        enabled: z.boolean(),
        reasoning_effort: z.string().optional(),
      })
      .optional(),
    thinking: z
      .object({
        enabled: z.boolean(),
        thinking_budget: z.number(),
      })
      .optional(),
  }),
  z.object({
    providerType: z.literal('ollama'),
    ...baseChatModelSchema.shape,
  }),
  z.object({
    providerType: z.literal('lm-studio'),
    ...baseChatModelSchema.shape,
  }),
  z.object({
    providerType: z.literal('deepseek'),
    ...baseChatModelSchema.shape,
  }),
  z.object({
    providerType: z.literal('perplexity'),
    ...baseChatModelSchema.shape,
    web_search_options: z
      .object({
        search_context_size: z.string(),
      })
      .optional(),
  }),
  z.object({
    providerType: z.literal('mistral'),
    ...baseChatModelSchema.shape,
  }),
  z.object({
    providerType: z.literal('morph'),
    ...baseChatModelSchema.shape,
  }),
  z.object({
    providerType: z.literal('azure-openai'),
    ...baseChatModelSchema.shape,
  }),
  z.object({
    providerType: z.literal('openai-compatible'),
    ...baseChatModelSchema.shape,
    // Same here: keep user freedom to configure across any provider
    reasoning: z
      .object({
        enabled: z.boolean(),
        reasoning_effort: z.string().optional(),
      })
      .optional(),
    thinking: z
      .object({
        enabled: z.boolean(),
        thinking_budget: z.number(),
      })
      .optional(),
    toolType: z.enum(['none', 'gemini']).default('none').optional(),
  }),
])

export type ChatModel = z.infer<typeof chatModelSchema>
