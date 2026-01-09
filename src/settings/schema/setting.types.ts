import { z } from 'zod'

import {
  DEFAULT_APPLY_MODEL_ID,
  DEFAULT_CHAT_MODELS,
  DEFAULT_CHAT_MODEL_ID,
  DEFAULT_EMBEDDING_MODELS,
  DEFAULT_PROVIDERS,
} from '../../constants'
import { assistantSchema } from '../../types/assistant.types'
import { chatModelSchema } from '../../types/chat-model.types'
import { embeddingModelSchema } from '../../types/embedding-model.types'
import { mcpServerConfigSchema } from '../../types/mcp.types'
import { llmProviderSchema } from '../../types/provider.types'

import { SETTINGS_SCHEMA_VERSION } from './migrations'

const ragOptionsSchema = z.object({
  enabled: z.boolean().catch(true),
  chunkSize: z.number().catch(1000),
  thresholdTokens: z.number().catch(8192),
  minSimilarity: z.number().catch(0.0),
  limit: z.number().catch(10),
  excludePatterns: z.array(z.string()).catch([]),
  includePatterns: z.array(z.string()).catch([]),
  // auto update options
  autoUpdateEnabled: z.boolean().catch(false),
  autoUpdateIntervalHours: z.number().catch(24),
  lastAutoUpdateAt: z.number().catch(0),
})

type TabCompletionOptionDefaults = {
  triggerDelayMs: number
  minContextLength: number
  contextRange: number // Combined context range, internally split 4:1 (before:after)
  maxSuggestionLength: number
  temperature: number
  requestTimeoutMs: number
}

// Legacy fields for migration compatibility
export type TabCompletionOptionLegacy = {
  maxBeforeChars?: number
  maxAfterChars?: number
  maxTokens?: number
  maxRetries?: number
}

export type TabCompletionTrigger = {
  id: string
  type: 'string' | 'regex'
  pattern: string
  enabled: boolean
  description?: string
}

export const TAB_COMPLETION_CONSTRAINTS_PLACEHOLDER =
  '{{tab_completion_constraints}}'
export const DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT =
  'Your job is to predict the most logical text that should be written at the location of the <mask/>. Your answer can be either code, a single word, or multiple sentences. Your answer must be in the same language as the text that is already there.' +
  `\n\nAdditional constraints:\n${TAB_COMPLETION_CONSTRAINTS_PLACEHOLDER}` +
  '\n\nYour response must have the following format:\nANSWER: here, you write the text that should be at the location of <mask/>.'

export const DEFAULT_TAB_COMPLETION_OPTIONS: TabCompletionOptionDefaults = {
  triggerDelayMs: 3000,
  minContextLength: 20,
  contextRange: 4000, // Total context chars, split 4:1 (3200 before, 800 after)
  maxSuggestionLength: 240,
  temperature: 0.5,
  requestTimeoutMs: 12000,
}

export const DEFAULT_TAB_COMPLETION_TRIGGERS: TabCompletionTrigger[] = [
  {
    id: 'sentence-end-comma',
    type: 'string',
    pattern: ', ',
    enabled: true,
  },
  {
    id: 'sentence-end-chinese-comma',
    type: 'string',
    pattern: '，',
    enabled: true,
  },
  {
    id: 'sentence-end-colon',
    type: 'string',
    pattern: ': ',
    enabled: true,
  },
  {
    id: 'sentence-end-chinese-colon',
    type: 'string',
    pattern: '：',
    enabled: true,
  },
  {
    id: 'newline',
    type: 'regex',
    pattern: '\\n$',
    enabled: true,
  },
  {
    id: 'list-item',
    type: 'regex',
    pattern: '(?:^|\\n)[-*+]\\s$',
    enabled: true,
  },
]

// Helper to compute maxTokens from maxSuggestionLength (roughly 1 token ≈ 3-4 chars)
export const computeMaxTokens = (maxSuggestionLength: number): number => {
  return Math.max(16, Math.min(2000, Math.ceil(maxSuggestionLength / 3)))
}

// Helper to split contextRange into before/after (4:1 ratio)
export const splitContextRange = (
  contextRange: number,
): { maxBeforeChars: number; maxAfterChars: number } => {
  const maxBeforeChars = Math.round((contextRange * 4) / 5)
  const maxAfterChars = contextRange - maxBeforeChars
  return { maxBeforeChars, maxAfterChars }
}

const tabCompletionOptionsSchema = z
  .object({
    triggerDelayMs: z
      .number()
      .min(200)
      .max(30000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.triggerDelayMs),
    minContextLength: z
      .number()
      .min(0)
      .max(2000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.minContextLength),
    contextRange: z
      .number()
      .min(500)
      .max(50000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.contextRange),
    maxSuggestionLength: z
      .number()
      .min(20)
      .max(4000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.maxSuggestionLength),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.temperature),
    requestTimeoutMs: z
      .number()
      .min(1000)
      .max(60000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.requestTimeoutMs),
    // Legacy fields kept for migration compatibility (will be removed in future)
    maxBeforeChars: z.number().optional(),
    maxAfterChars: z.number().optional(),
    maxTokens: z.number().optional(),
    maxRetries: z.number().optional(),
  })
  .catch({ ...DEFAULT_TAB_COMPLETION_OPTIONS })

const tabCompletionTriggerSchema = z
  .object({
    id: z.string(),
    type: z.enum(['string', 'regex']),
    pattern: z.string(),
    enabled: z.boolean().catch(true),
    description: z.string().optional(),
  })
  .catch({
    id: '',
    type: 'string',
    pattern: '',
    enabled: true,
  })

/**
 * Settings
 */

export const smartComposerSettingsSchema = z.object({
  // Version
  version: z.literal(SETTINGS_SCHEMA_VERSION).catch(SETTINGS_SCHEMA_VERSION),

  providers: z.array(llmProviderSchema).catch([...DEFAULT_PROVIDERS]),

  chatModels: z.array(chatModelSchema).catch([...DEFAULT_CHAT_MODELS]),

  embeddingModels: z
    .array(embeddingModelSchema)
    .catch([...DEFAULT_EMBEDDING_MODELS]),

  chatModelId: z
    .string()
    .catch(
      DEFAULT_CHAT_MODELS.find((v) => v.id === DEFAULT_CHAT_MODEL_ID)?.id ??
        DEFAULT_CHAT_MODELS[0].id,
    ), // model for default chat feature
  applyModelId: z
    .string()
    .catch(
      DEFAULT_CHAT_MODELS.find((v) => v.id === DEFAULT_APPLY_MODEL_ID)?.id ??
        DEFAULT_CHAT_MODELS[0].id,
    ), // model for apply feature
  embeddingModelId: z.string().catch(DEFAULT_EMBEDDING_MODELS[0].id), // model for embedding

  // System Prompt
  systemPrompt: z.string().catch(''),

  // RAG Options
  ragOptions: ragOptionsSchema.catch({
    enabled: true,
    chunkSize: 1000,
    thresholdTokens: 8192,
    minSimilarity: 0.0,
    limit: 10,
    excludePatterns: [],
    includePatterns: [],
    autoUpdateEnabled: false,
    autoUpdateIntervalHours: 24,
    lastAutoUpdateAt: 0,
  }),

  // MCP configuration
  mcp: z
    .object({
      servers: z.array(mcpServerConfigSchema).catch([]),
    })
    .catch({
      servers: [],
    }),

  // Chat options
  chatOptions: z
    .object({
      includeCurrentFileContent: z.boolean(),
      enableTools: z.boolean(),
      maxAutoIterations: z.number(),
      maxContextMessages: z.number(),
      chatTitlePrompt: z.string().optional(),
      baseModelSpecialPrompt: z.string().optional(),
      // Chat mode (chat/agent)
      chatMode: z.enum(['chat', 'agent']).optional(),
    })
    .catch({
      includeCurrentFileContent: true,
      enableTools: true,
      maxAutoIterations: 1,
      maxContextMessages: 32,
      chatTitlePrompt: '',
      baseModelSpecialPrompt: '',
      chatMode: 'chat',
    }),

  // Continuation (续写) options
  continuationOptions: z
    .object({
      // dedicated continuation model
      continuationModelId: z.string().optional(),
      // enable smart space quick invoke
      enableSmartSpace: z.boolean().optional(),
      // enable selection chat (Cursor-like text selection actions)
      enableSelectionChat: z.boolean().optional(),
      // enable manual context selection for continuation
      manualContextEnabled: z.boolean().optional(),
      // manual context folders picked by user from the vault
      manualContextFolders: z.array(z.string()).optional(),
      // folders that should be fully injected into continuation context
      referenceRuleFolders: z.array(z.string()).optional(),
      // folders used as the scoped knowledge base for RAG retrieval
      knowledgeBaseFolders: z.array(z.string()).optional(),
      // override sampling parameters specifically for continuation
      temperature: z.number().min(0).max(2).optional(),
      topP: z.number().min(0).max(1).optional(),
      // enable or disable streaming responses for continuation results
      stream: z.boolean().optional(),
      // whether continuation requests should include RAG / vault search context
      useVaultSearch: z.boolean().optional(),
      // cap on how many characters of context to send with continuation requests
      maxContinuationChars: z.number().int().min(0).optional(),
      // enable tab completion based on prefix suggestion
      enableTabCompletion: z.boolean().optional(),
      // fixed model id for tab completion suggestions
      tabCompletionModelId: z.string().optional(),
      // extra options for tab completion behavior
      tabCompletionOptions: tabCompletionOptionsSchema.optional(),
      // triggers used to invoke tab completion
      tabCompletionTriggers: z
        .array(tabCompletionTriggerSchema)
        .catch([...DEFAULT_TAB_COMPLETION_TRIGGERS]),
      // override system prompt for tab completion
      tabCompletionSystemPrompt: z.string().optional(),
      // extra prompt constraints for tab completion
      tabCompletionConstraints: z.string().optional(),
      // Smart Space custom quick actions
      smartSpaceQuickActions: z
        .array(
          z.object({
            id: z.string(),
            label: z.string(),
            instruction: z.string(),
            icon: z.string().optional(),
            category: z
              .enum(['suggestions', 'writing', 'thinking', 'custom'])
              .optional(),
            enabled: z.boolean().default(true),
          }),
        )
        .optional(),
      // Empty-line trigger mode for Smart Space
      smartSpaceTriggerMode: z
        .enum(['single-space', 'double-space', 'off'])
        .optional(),
      // Smart Space Gemini tools default state
      smartSpaceUseWebSearch: z.boolean().optional(),
      smartSpaceUseUrlContext: z.boolean().optional(),
      // enable quick ask feature (@ trigger in empty line)
      enableQuickAsk: z.boolean().optional(),
      // trigger character for quick ask (default: @)
      quickAskTrigger: z.string().optional(),
      // quick ask mode: 'ask' for Q&A, 'edit' for document editing with preview, 'edit-direct' for direct editing
      quickAskMode: z.enum(['ask', 'edit', 'edit-direct']).optional(),
    })
    .catch({
      continuationModelId:
        DEFAULT_CHAT_MODELS.find((v) => v.id === DEFAULT_APPLY_MODEL_ID)?.id ??
        DEFAULT_CHAT_MODELS[0].id,
      enableSmartSpace: true,
      enableSelectionChat: true,
      manualContextEnabled: false,
      manualContextFolders: [],
      referenceRuleFolders: [],
      knowledgeBaseFolders: [],
      stream: true,
      useVaultSearch: false,
      maxContinuationChars: 8000,
      enableTabCompletion: false,
      tabCompletionModelId:
        DEFAULT_CHAT_MODELS.find((v) => v.id === DEFAULT_APPLY_MODEL_ID)?.id ??
        DEFAULT_CHAT_MODELS[0].id,
      tabCompletionOptions: { ...DEFAULT_TAB_COMPLETION_OPTIONS },
      tabCompletionTriggers: [...DEFAULT_TAB_COMPLETION_TRIGGERS],
      tabCompletionSystemPrompt: DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
      tabCompletionConstraints: '',
      smartSpaceQuickActions: undefined,
      smartSpaceTriggerMode: 'single-space',
      smartSpaceUseWebSearch: false,
      smartSpaceUseUrlContext: false,
      enableQuickAsk: true,
      quickAskTrigger: '@',
      quickAskMode: 'ask',
    }),

  // Assistant list
  assistants: z.array(assistantSchema).catch([]),

  // Currently selected assistant ID
  currentAssistantId: z.string().optional(),

  // Language preference (auto follows Obsidian)
  languagePreference: z.enum(['auto', 'en', 'zh', 'it']).catch('auto'),
})
export type SmartComposerSettings = z.infer<typeof smartComposerSettingsSchema>

export type SettingMigration = {
  fromVersion: number
  toVersion: number
  migrate: (data: Record<string, unknown>) => Record<string, unknown>
}
