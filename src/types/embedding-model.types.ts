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
  // Native output dimension probed when the model was first added.
  // Used to decide whether to send `dimensions` parameter at runtime.
  nativeDimension: z.number().int().positive().optional(),
})

export type EmbeddingModel = z.infer<typeof embeddingModelSchema>
