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

export const assistantToolDisclosureModeSchema = z.enum(['always', 'on_demand'])

export type AssistantToolDisclosureMode = z.infer<
  typeof assistantToolDisclosureModeSchema
>

export const assistantToolPreferenceSchema = z.object({
  enabled: z.boolean().optional(),
  approvalMode: assistantToolApprovalModeSchema.optional(),
  disclosureMode: assistantToolDisclosureModeSchema.optional(),
})

export type AssistantToolPreference = z.infer<
  typeof assistantToolPreferenceSchema
>

export const assistantToolServerPreferenceSchema = z.object({
  approvalMode: assistantToolApprovalModeSchema.optional(),
})

export type AssistantToolServerPreference = z.infer<
  typeof assistantToolServerPreferenceSchema
>

export const assistantWorkspaceScopeSchema = z.object({
  enabled: z.boolean().default(false),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
})

export type AssistantWorkspaceScope = z.infer<
  typeof assistantWorkspaceScopeSchema
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
  toolServerPreferences: z
    .record(z.string(), assistantToolServerPreferenceSchema)
    .optional(),
  // Legacy: per-assistant enabled skill list, keyed by canonical skill name.
  enabledSkills: z.array(z.string()).optional(),
  // Per-assistant skill preferences, keyed by canonical skill *name*
  // (frontmatter `name`, trim-only, case-sensitive). Field/key names kept for
  // backwards compatibility; keys are skill names, not a separate id.
  skillPreferences: z
    .record(z.string(), assistantSkillPreferenceSchema)
    .optional(),
  workspaceScope: assistantWorkspaceScopeSchema.optional(),
  enableProjectInstructions: z.boolean().optional(),
  // Per-agent focus sync (current file pointer injection in sidebar chat).
  includeCurrentFileContent: z.boolean().optional(),
  // Per-agent time awareness (<current_time> prefix on new user messages).
  timeContextEnabled: z.boolean().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
})

export type Assistant = z.infer<typeof assistantSchema>
