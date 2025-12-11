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

// 模块化系统提示词类型定义
export const promptModuleSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(50),
  content: z.string(),
  enabled: z.boolean().default(true),
  order: z.number().default(0),
})

export const promptGroupSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(30),
  enabled: z.boolean().default(true),
  prompts: z.array(promptModuleSchema).default([]),
  order: z.number().default(0),
})

export const modularPromptDataSchema = z.object({
  groups: z.array(promptGroupSchema).default([]),
})

export type PromptModule = z.infer<typeof promptModuleSchema>
export type PromptGroup = z.infer<typeof promptGroupSchema>
export type ModularPromptData = z.infer<typeof modularPromptDataSchema>

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
  maxContextChars: number
  maxSuggestionLength: number
  maxTokens: number
  temperature: number
  requestTimeoutMs: number
  maxRetries: number
}

export const DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT =
  "You are a helpful assistant providing inline writing suggestions. Predict a concise continuation after the user's cursor. Do not repeat existing text. Return only the suggested continuation without quotes or extra commentary."

export const DEFAULT_TAB_COMPLETION_OPTIONS: TabCompletionOptionDefaults = {
  triggerDelayMs: 3000,
  minContextLength: 20,
  maxContextChars: 4000,
  maxSuggestionLength: 240,
  maxTokens: 64,
  temperature: 0.5,
  requestTimeoutMs: 12000,
  maxRetries: 0,
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
    maxContextChars: z
      .number()
      .min(200)
      .max(40000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.maxContextChars),
    maxSuggestionLength: z
      .number()
      .min(20)
      .max(4000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.maxSuggestionLength),
    maxTokens: z
      .number()
      .min(16)
      .max(2000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.maxTokens),
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
    maxRetries: z
      .number()
      .min(0)
      .max(5)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.maxRetries),
  })
  .catch({ ...DEFAULT_TAB_COMPLETION_OPTIONS })

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

  // Modular System Prompt Data
  modularPromptData: modularPromptDataSchema.optional(),

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
      // Default conversation parameters
      defaultTemperature: z.number().min(0).max(2).optional(),
      defaultTopP: z.number().min(0).max(1).optional(),
      chatTitlePrompt: z.string().optional(),
      baseModelSpecialPrompt: z.string().optional(),
    })
    .catch({
      includeCurrentFileContent: true,
      enableTools: true,
      maxAutoIterations: 1,
      maxContextMessages: 32,
      defaultTemperature: 0.8,
      defaultTopP: 0.9,
      chatTitlePrompt: '',
      baseModelSpecialPrompt: '',
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
      // override system prompt for tab completion
      tabCompletionSystemPrompt: z.string().optional(),
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
      tabCompletionSystemPrompt: DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
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

  // Language setting
  language: z.enum(['en', 'zh', 'it']).catch('en'),
})
export type SmartComposerSettings = z.infer<typeof smartComposerSettingsSchema>

export type SettingMigration = {
  fromVersion: number
  toVersion: number
  migrate: (data: Record<string, unknown>) => Record<string, unknown>
}
