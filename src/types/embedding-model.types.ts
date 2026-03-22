import { z } from 'zod'

export const embeddingModelSchema = z.object({
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
  dimension: z.number(),
})

export type EmbeddingModel = z.infer<typeof embeddingModelSchema>
