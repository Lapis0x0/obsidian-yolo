import { z } from 'zod'

// Assistant icon type definition
export const assistantIconSchema = z.object({
  type: z.enum(['lucide', 'emoji']),
  value: z.string(),
})

export type AssistantIcon = z.infer<typeof assistantIconSchema>

export const agentPersonaSchema = z.enum(['balanced', 'precise', 'creative'])

export type AgentPersona = z.infer<typeof agentPersonaSchema>

export const assistantSkillLoadModeSchema = z.enum(['always', 'lazy'])
export type AssistantSkillLoadMode = z.infer<
  typeof assistantSkillLoadModeSchema
>

export const assistantSkillPreferenceSchema = z.object({
  enabled: z.boolean().optional(),
  loadMode: assistantSkillLoadModeSchema.optional(),
})

export type AssistantSkillPreference = z.infer<
  typeof assistantSkillPreferenceSchema
>

export const assistantToolApprovalModeSchema = z.enum([
  'full_access',
  'require_approval',
])

export type AssistantToolApprovalMode = z.infer<
  typeof assistantToolApprovalModeSchema
>

export const assistantToolPreferenceSchema = z.object({
  enabled: z.boolean().optional(),
  approvalMode: assistantToolApprovalModeSchema.optional(),
})

export type AssistantToolPreference = z.infer<
  typeof assistantToolPreferenceSchema
>

// Assistant type definition
export const assistantSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name cannot be empty'),
  description: z.string().optional(),
  systemPrompt: z.string().default(''),
  icon: assistantIconSchema.optional(),
  persona: agentPersonaSchema.optional(),
  modelId: z.string().optional(),
  enableTools: z.boolean().optional(),
  includeBuiltinTools: z.boolean().optional(),
  enabledToolNames: z.array(z.string()).optional(),
  toolPreferences: z
    .record(z.string(), assistantToolPreferenceSchema)
    .optional(),
  enabledSkills: z.array(z.string()).optional(),
  skillPreferences: z
    .record(z.string(), assistantSkillPreferenceSchema)
    .optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
})

export type Assistant = z.infer<typeof assistantSchema>
