import { z } from 'zod'

import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_CHAT_TITLE_MODEL_ID,
} from '../../constants'
import { CLI_RUNTIME_IDS } from '../../core/cli-runtime/types'
import { DEFAULT_LOCAL_MCP_SERVER_PORT } from '../../core/mcp/localMcpServerConfig'
import { DEFAULT_LOCAL_EMBEDDING_ENDPOINT } from '../../core/rag/local-embedding/constants'
import { webSearchSettingsSchema } from '../../core/web-search/types'
import { assistantSchema } from '../../types/assistant.types'
import { chatModelSchema } from '../../types/chat-model.types'
import { embeddingModelSchema } from '../../types/embedding-model.types'
import {
  mcpServerConfigSchema,
  mcpServerToolOptionsSchema,
} from '../../types/mcp.types'
import { llmProviderSchema } from '../../types/provider.types'
import { REASONING_LEVELS, ReasoningLevel } from '../../types/reasoning'
import { DEFAULT_CHAT_QUICK_ACCESS_ENTRIES } from '../chatQuickAccess'

import { SETTINGS_SCHEMA_VERSION } from './migrations/version'

const resilientArraySchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z
    .array(z.unknown())
    .transform((items): Array<z.infer<T>> => {
      return items.flatMap((item) => {
        const parsed = itemSchema.safeParse(item)
        return parsed.success ? [parsed.data] : []
      })
    })
    .catch([])

const ragOptionsSchema = z.object({
  enabled: z.boolean().catch(true),
  chunkSize: z.number().catch(1000),
  thresholdTokens: z.number().catch(20000),
  minSimilarity: z.number().catch(0.0),
  limit: z.number().catch(10),
  /**
   * Max parallel embedding requests during indexing. Lower this when the
   * embedding provider returns 429 / rate-limit errors (e.g. Azure S0 tier
   * or per-minute-quota free tiers). Clamped to [1, 24] at the call site.
   */
  embeddingConcurrency: z.number().catch(10),
  /** When true, index `.pdf` files for RAG (text extraction). */
  indexPdf: z.boolean().catch(true),
  // auto update options
  autoUpdateEnabled: z.boolean().catch(true),
  autoUpdateIntervalHours: z.number().catch(0),
  lastAutoUpdateAt: z.number().catch(0),
})

/**
 * One independently-indexed knowledge base: its own vector store
 * (`yolo-vector:<vaultNs>:<kbId>`), scoped to `include`/`exclude` (same
 * semantics as `scopeRules.ts`: any exclude wins; empty `include` = whole
 * vault; otherwise a path must match an include rule). All knowledge bases
 * share the single global `embeddingModelId` and the maintenance knobs left
 * on `ragOptions` (chunkSize, minSimilarity, limit, embeddingConcurrency,
 * indexPdf, autoUpdate*). `name` is the model-facing selector for
 * `vault_search`'s `knowledgeBase` argument (matched case-insensitively,
 * trimmed) — keep it unique. `description` is optional, model-facing
 * context for picking the right base; never shown to the user as anything
 * but their own words.
 */
export const knowledgeBaseSchema = z.object({
  id: z.string(),
  name: z.string().catch(''),
  description: z.string().catch(''),
  include: z.array(z.string()).catch([]),
  exclude: z.array(z.string()).catch([]),
})
export type KnowledgeBase = z.infer<typeof knowledgeBaseSchema>

const localEmbeddingSettingsSchema = z.object({
  endpoint: z.string().catch(DEFAULT_LOCAL_EMBEDDING_ENDPOINT),
})
export type LocalEmbeddingSettings = z.infer<
  typeof localEmbeddingSettingsSchema
>

/**
 * `knowledgeBases` validation runs in two stages:
 * 1. `resilientArraySchema` drops any item that fails `knowledgeBaseSchema`
 *    outright (missing `id`, wrong types, ...) — same as every other
 *    settings array, so one corrupted entry never blocks the rest.
 * 2. This `.superRefine` then validates the survivors as a set: `name` must
 *    be non-empty after trimming, and both `id` and the trimmed,
 *    case-insensitive `name` must be unique — `name` is the model-facing
 *    selector `vault_search`'s `knowledgeBase` argument matches against (see
 *    `knowledgeBaseSchema`'s doc comment), so two bases sharing one make
 *    that argument ambiguous.
 *
 * Unlike stage 1, a violation here fails the whole `knowledgeBases` field
 * instead of silently dropping the offending entry. That is deliberate: it
 * is what lets `import-config.ts`'s `safeParse` (and `main.ts`'s
 * `setSettings`) surface a clear "duplicate knowledge base" error instead of
 * silently discarding one of the two. On the disk-load path
 * (`parseYoloSettings`), a failure here falls back to full schema defaults
 * like any other unparseable settings field — pre-existing, systemic
 * behavior, not specific to this field.
 */
const knowledgeBasesFieldSchema = resilientArraySchema(knowledgeBaseSchema)
  .transform((items) =>
    items.map((item) => ({ ...item, name: item.name.trim() })),
  )
  .superRefine((items, ctx) => {
    const seenIds = new Set<string>()
    const seenNames = new Set<string>()
    items.forEach((item, index) => {
      if (item.name.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Knowledge base at index ${index} has an empty name`,
          path: [index, 'name'],
        })
        return
      }
      if (seenIds.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate knowledge base id "${item.id}"`,
          path: [index, 'id'],
        })
      }
      seenIds.add(item.id)

      const nameKey = item.name.toLowerCase()
      if (seenNames.has(nameKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate knowledge base name "${item.name}"`,
          path: [index, 'name'],
        })
      }
      seenNames.add(nameKey)
    })
  })

type TabCompletionOptionDefaults = {
  multipleCandidatesEnabled: boolean
  idleTriggerEnabled: boolean
  autoTriggerDelayMs: number
  autoTriggerCooldownMs: number
  triggerDelayMs: number
  minContextLength: number
  contextRange: number // Combined context range, internally split 4:1 (before:after)
  maxSuggestionLength: number
  temperature: number
  requestTimeoutMs: number
  reasoningLevel: ReasoningLevel
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
  acceptMode: 'insert' | 'replace'
  description?: string
}

export type TabCompletionLengthPreset = 'short' | 'medium' | 'long'

export const TAB_COMPLETION_CONSTRAINTS_PLACEHOLDER =
  '{{tab_completion_constraints}}'
export const DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT =
  'Your job is to predict the most logical text that should be written at the location of the <mask/>. Your answer can be either code, a single word, or multiple sentences. Your answer must be in the same language as the text that is already there.' +
  `\n\nAdditional constraints:\n${TAB_COMPLETION_CONSTRAINTS_PLACEHOLDER}` +
  '\n\nOutput only the text that should appear at the <mask/>. Do not include explanations, labels, or formatting.'

export const DEFAULT_TAB_COMPLETION_LENGTH_PRESET: TabCompletionLengthPreset =
  'medium'

export const notificationChannelSchema = z.enum(['sound', 'system', 'both'])
export type NotificationChannel = z.infer<typeof notificationChannelSchema>
export const notificationTimingSchema = z.enum(['always', 'when-unfocused'])
export type NotificationTiming = z.infer<typeof notificationTimingSchema>

export const DEFAULT_TAB_COMPLETION_OPTIONS: TabCompletionOptionDefaults = {
  multipleCandidatesEnabled: true,
  idleTriggerEnabled: false,
  autoTriggerDelayMs: 3000,
  autoTriggerCooldownMs: 15000,
  triggerDelayMs: 3000,
  minContextLength: 5,
  contextRange: 4000, // Total context chars, split 4:1 (3200 before, 800 after)
  maxSuggestionLength: 2000, // Legacy; no longer applied at request/render time
  temperature: 0.5, // Legacy; tab completion no longer sends temperature
  requestTimeoutMs: 12000,
  // Tab 补全是延迟敏感场景，默认关闭推理；用户可在设置中改为 low / auto 以适配强制推理的模型（如 gpt-oss）
  reasoningLevel: 'off',
}

export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 60000
export const MAX_MODEL_REQUEST_TIMEOUT_MS = 60 * 60 * 1000

const notificationOptionsSchema = z
  .object({
    enabled: z.boolean().optional(),
    channel: notificationChannelSchema.optional(),
    timing: notificationTimingSchema.optional(),
    notifyOnApprovalRequired: z.boolean().optional(),
    notifyOnTaskCompleted: z.boolean().optional(),
  })
  .catch({
    enabled: false,
    channel: 'sound',
    timing: 'when-unfocused',
    notifyOnApprovalRequired: true,
    notifyOnTaskCompleted: true,
  })

export const DEFAULT_TAB_COMPLETION_TRIGGERS: TabCompletionTrigger[] = [
  {
    id: 'sentence-end-comma',
    type: 'string',
    pattern: ', ',
    enabled: true,
    acceptMode: 'insert',
  },
  {
    id: 'sentence-end-chinese-comma',
    type: 'string',
    pattern: '，',
    enabled: true,
    acceptMode: 'insert',
  },
  {
    id: 'sentence-end-colon',
    type: 'string',
    pattern: ': ',
    enabled: true,
    acceptMode: 'insert',
  },
  {
    id: 'sentence-end-chinese-colon',
    type: 'string',
    pattern: '：',
    enabled: true,
    acceptMode: 'insert',
  },
  {
    id: 'newline',
    type: 'regex',
    pattern: '\\n$',
    enabled: true,
    acceptMode: 'insert',
  },
  {
    id: 'list-item',
    type: 'regex',
    pattern: '(?:^|\\n)[-*+]\\s$',
    enabled: true,
    acceptMode: 'insert',
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
    multipleCandidatesEnabled: z
      .boolean()
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.multipleCandidatesEnabled),
    idleTriggerEnabled: z
      .boolean()
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.idleTriggerEnabled),
    autoTriggerDelayMs: z
      .number()
      .min(200)
      .max(30000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.autoTriggerDelayMs),
    autoTriggerCooldownMs: z
      .number()
      .min(0)
      .max(600000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.autoTriggerCooldownMs),
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
    reasoningLevel: z
      .enum(REASONING_LEVELS)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.reasoningLevel),
    // Legacy fields kept for migration compatibility (will be removed in future)
    maxBeforeChars: z.number().optional(),
    maxAfterChars: z.number().optional(),
    maxTokens: z.number().optional(),
    maxRetries: z.number().optional(),
  })
  .catch({ ...DEFAULT_TAB_COMPLETION_OPTIONS })

export const jsSandboxSettingsSchema = z.object({
  allowDbQuery: z.boolean().optional(),
  allowFetch: z.boolean().optional(),
  fetchMode: z.enum(['whitelist', 'blacklist']).optional(),
  fetchDomains: z.array(z.string()).optional(),
  fetchMaxConcurrent: z.number().optional(),
  fetchMaxResponseKb: z.number().optional(),
  allowVaultRead: z.boolean().optional(),
  // Maximum size (in KB) returned by $vault.readText / $vault.readBinary.
  // Files exceeding this are truncated (text) or refused (binary).
  vaultReadMaxKb: z.number().optional(),
  allowBrowserRead: z.boolean().optional(),
  // Maximum size (in KB) returned by $browser.readHtml. Pages exceeding
  // this are refused so callers do not silently receive partial HTML.
  browserReadMaxKb: z.number().optional(),
  allowExternalScripts: z.boolean().optional(),
  // Execution timeout cap, in milliseconds. The LLM may pass a smaller
  // timeoutMs in its tool args, but the host clamps the effective value
  // to this cap. Undefined means use the built-in default.
  timeoutMs: z.number().optional(),
  // Maximum rows returned by $db.search (knowledge-base RAG/vector search).
  dbQueryMaxLimit: z.number().optional(),
  // Maximum size (in KB) of the tool's serialized JSON result returned to
  // the model. Output above this is truncated with a prefix. Undefined
  // uses the built-in default. Host enforces a hard ceiling.
  outputMaxKb: z.number().optional(),
})

export type JsSandboxSettings = z.infer<typeof jsSandboxSettingsSchema>

const tabCompletionTriggerSchema = z
  .object({
    id: z.string(),
    type: z.enum(['string', 'regex']),
    pattern: z.string(),
    enabled: z.boolean().catch(true),
    acceptMode: z.enum(['insert', 'replace']).catch('insert'),
    description: z.string().optional(),
  })
  .catch({
    id: '',
    type: 'string',
    pattern: '',
    enabled: true,
    acceptMode: 'insert',
  })

/**
 * Settings
 */

export const yoloSettingsSchema = z.object({
  // Version
  version: z.literal(SETTINGS_SCHEMA_VERSION).catch(SETTINGS_SCHEMA_VERSION),

  providers: resilientArraySchema(llmProviderSchema),

  chatModels: resilientArraySchema(chatModelSchema),

  embeddingModels: resilientArraySchema(embeddingModelSchema),

  chatModelId: z.string().catch(''), // model for default chat feature
  chatTitleModelId: z.string().catch(''), // model for automatic conversation naming
  embeddingModelId: z.string().catch(''), // model for embedding

  // System Prompt
  systemPrompt: z.string().catch(''),

  // 时间感知:开启后,每条新用户消息发送时固定当前时间并以 <current_time> 前缀注入。
  // 只影响之后的新消息,历史消息已固定不变。
  timeContextEnabled: z.boolean().catch(true),

  // 更新提示:同版本第一次关闭后记录软关闭版本,下次启动仍提示一次。
  softDismissedUpdateVersion: z.string().catch(''),

  // 更新提示:同版本第二次关闭后记录被静音的版本号,只有出现更高版本才会再次提示。
  mutedUpdateVersion: z.string().catch(''),

  // 模块更新提示:按模块记录被静音的版本,更高版本仍会重新提示。
  mutedModuleUpdateVersions: z.record(z.string(), z.string()).catch({}),

  /**
   * 检测到新版本时是否弹出更新卡片。关闭后主插件与模块都不再提示,也不再自动
   * 下载(没有卡片就没有安装入口)。分发源 Feed 仍然照常请求——它同时是模块
   * 目录的数据源,`设置 → 模块` 的更新按钮依赖它。
   */
  pluginUpdateNoticeEnabled: z.boolean().catch(true),

  /** 检测到新版本时在后台自动下载 release 文件；安装仍需用户确认。 */
  pluginUpdateAutoDownloadEnabled: z.boolean().catch(true),

  // RAG Options
  ragOptions: ragOptionsSchema.catch({
    enabled: true,
    chunkSize: 1000,
    thresholdTokens: 20000,
    minSimilarity: 0.0,
    limit: 10,
    embeddingConcurrency: 10,
    indexPdf: true,
    autoUpdateEnabled: true,
    autoUpdateIntervalHours: 0,
    lastAutoUpdateAt: 0,
  }),

  /**
   * Independently-indexed knowledge bases. Never auto-populated by
   * migration — upgrading users start at `[]` and create their own (the
   * IndexedDB-backed vector store already requires a from-scratch rebuild).
   */
  knowledgeBases: knowledgeBasesFieldSchema,

  /**
   * Local (on-device) embedding model download settings — see
   * docs/plans/08-22-local-embedding/00-plan.md §3.4. `endpoint` is the
   * Hugging Face Hub-compatible host model files are resolved against
   * (`${endpoint}/${hfRepo}/resolve/${revision}/${file}`); a purely additive
   * field with a schema default, so it needs no migration entry of its own.
   */
  localEmbedding: localEmbeddingSettingsSchema.catch({
    endpoint: DEFAULT_LOCAL_EMBEDDING_ENDPOINT,
  }),

  // MCP configuration
  mcp: z
    .object({
      servers: resilientArraySchema(mcpServerConfigSchema),
      /**
       * Keyed by `BuiltinCapabilityId` as of the `80_to_81` settings
       * migration (D9, docs/plans/2026-08-15-tool-registry/phase2-migration.md
       * D9) — was `builtinToolOptions`, keyed by the pre-capability short
       * tool/group names. Reuses `mcpServerToolOptionsSchema` unchanged: this
       * map carries more than `disabled` — `delegate_subagent`'s
       * `allowedModelIds`/`preferredModelId` and `terminal_command`'s
       * `blockedPrefixes` live here too, now under `subagent_delegation` /
       * `terminal` respectively.
       */
      builtinCapabilityOptions: mcpServerToolOptionsSchema.catch({}),
      enableToolDisclosure: z.boolean().catch(false),
      localServer: z
        .object({
          enabled: z.boolean().catch(false),
          port: z
            .number()
            .int()
            .min(1024)
            .max(65535)
            .catch(DEFAULT_LOCAL_MCP_SERVER_PORT),
          token: z.string().catch(''),
        })
        .catch({
          enabled: false,
          port: DEFAULT_LOCAL_MCP_SERVER_PORT,
          token: '',
        }),
    })
    .catch({
      servers: [],
      builtinCapabilityOptions: {},
      enableToolDisclosure: false,
      localServer: {
        enabled: false,
        port: DEFAULT_LOCAL_MCP_SERVER_PORT,
        token: '',
      },
    }),

  // JS sandbox (js_eval) capability configuration is global; execution
  // approval remains a per-agent tool preference.
  jsSandbox: jsSandboxSettingsSchema.catch({}),

  // Web search configuration (built-in agent tool)
  webSearch: webSearchSettingsSchema.catch({
    providers: [],
    defaultProviderId: undefined,
    common: {
      resultSize: 10,
      searchTimeoutMs: 120000,
      scrapeTimeoutMs: 20000,
    },
  }),

  // Skills configuration
  skills: z
    .object({
      // Globally disabled skills, stored by canonical skill *name* (frontmatter
      // `name`, trim-only, case-sensitive). Field name kept for backwards
      // compatibility; its elements are skill names, not a separate id.
      disabledSkillIds: z.array(z.string()).catch([]),
    })
    .catch({
      disabledSkillIds: [],
    }),

  // YOLO workspace configuration
  yolo: z
    .object({
      baseDir: z.string().catch('YOLO'),
    })
    .catch({
      baseDir: 'YOLO',
    }),

  debug: z
    .object({
      captureRawRequestDebug: z.boolean().optional(),
    })
    .catch({
      captureRawRequestDebug: false,
    }),

  // Chat options
  chatOptions: z
    .object({
      includeCurrentFileContent: z.boolean(),
      mentionDisplayMode: z.enum(['inline', 'badge']).optional(),
      mentionContextMode: z.enum(['light', 'full']).optional(),
      enterKeyCreatesNewline: z.boolean().optional(),
      chatInputHeight: z.number().int().min(80).max(520).optional(),
      chatApplyMode: z.enum(['review-required', 'direct-apply']).optional(),
      chatTitlePrompt: z.string().optional(),
      // Chat mode (ask/agent)
      chatMode: z.enum(['ask', 'agent']).optional(),
      // Auto-approve tool calls (YOLO). Orthogonal to chatMode; only effective
      // in Agent mode.
      agentYoloEnabled: z.boolean().optional(),
      // Whether the user has acknowledged the first-time full access (YOLO) warning
      fullAccessWarningConfirmed: z.boolean().optional(),
      // Persist preferred reasoning level per model id in Chat input
      reasoningLevelByModelId: z
        .record(z.string(), z.enum(REASONING_LEVELS))
        .optional(),
      // Auto context compaction prompt injected at runtime LLM boundaries
      // (based on last assistant usage).
      autoContextCompactionEnabled: z.boolean().optional(),
      autoContextCompactionThresholdMode: z
        .enum(['tokens', 'ratio'])
        .optional(),
      autoContextCompactionThresholdTokens: z.number().int().min(1).optional(),
      autoContextCompactionThresholdRatio: z.number().min(0).max(1).optional(),
      // Font scale factor for chat messages (1 = default)
      chatFontScale: z.number().min(0.7).max(1.5).optional(),
      // Image reading & compression for vision tool calls
      imageReadingEnabled: z.boolean().optional(),
      imageCompressionEnabled: z.boolean().optional(),
      imageCompressionQuality: z.number().min(1).max(100).optional(),
      // Fetch external (http/https) image URLs referenced in Markdown
      externalImageFetchEnabled: z.boolean().optional(),
      // Include assistant reasoning in exported chat markdown
      chatExportIncludeThinking: z.boolean().optional(),
      // Include tool call blocks in exported chat markdown
      chatExportIncludeToolCalls: z.boolean().optional(),
      // Where the ribbon icon should open the Chat view
      ribbonClickAction: z
        .enum(['sidebar', 'tab', 'split', 'window', 'last'])
        .optional(),
      // Last placement actually used to open a chat leaf; only consulted when
      // `ribbonClickAction === 'last'`
      lastChatPlacement: z
        .enum(['sidebar', 'tab', 'split', 'window'])
        .optional(),
      // Last user-selected conversation surface and CLI provider. Kept
      // separately so returning to Chat does not forget the preferred CLI.
      lastChatSurface: z.enum(['chat', 'cli']).optional(),
      lastCliRuntimeId: z.enum(CLI_RUNTIME_IDS).optional(),
      cliModelIdByRuntime: z
        .record(z.enum(CLI_RUNTIME_IDS), z.string().optional())
        .optional(),
      cliReasoningEffortByModel: z.record(z.string(), z.string()).optional(),
      // Last CLI chat mode (agent/plan) remembered per CLI runtime.
      cliChatModeByRuntime: z
        .record(z.enum(CLI_RUNTIME_IDS), z.enum(['agent', 'plan']).optional())
        .optional(),
      // Last CLI YOLO flag remembered per CLI runtime.
      cliAgentYoloEnabledByRuntime: z
        .record(z.enum(CLI_RUNTIME_IDS), z.boolean().optional())
        .optional(),
      quickAccessEntries: resilientArraySchema(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('skill'), name: z.string().min(1) }),
          z.object({ type: z.literal('snippet'), id: z.string().min(1) }),
        ]),
      ).optional(),
    })
    .catch({
      includeCurrentFileContent: true,
      mentionDisplayMode: 'inline',
      mentionContextMode: 'light',
      chatInputHeight: undefined,
      chatApplyMode: 'review-required',
      chatTitlePrompt: '',
      chatMode: 'agent',
      fullAccessWarningConfirmed: false,
      reasoningLevelByModelId: {},
      autoContextCompactionEnabled: false,
      autoContextCompactionThresholdMode: 'tokens',
      autoContextCompactionThresholdTokens: 100000,
      autoContextCompactionThresholdRatio: 0.8,
      chatFontScale: undefined,
      imageReadingEnabled: true,
      imageCompressionEnabled: true,
      imageCompressionQuality: 85,
      externalImageFetchEnabled: false,
      chatExportIncludeThinking: false,
      chatExportIncludeToolCalls: false,
      ribbonClickAction: 'sidebar',
      lastChatSurface: 'chat',
      lastCliRuntimeId: 'claude-code',
      cliModelIdByRuntime: {},
      cliReasoningEffortByModel: {},
      cliChatModeByRuntime: {},
      cliAgentYoloEnabledByRuntime: {},
      lastChatPlacement: undefined,
      quickAccessEntries: DEFAULT_CHAT_QUICK_ACCESS_ENTRIES,
    }),

  notificationOptions: notificationOptionsSchema,

  learningOptions: z.unknown().optional(),

  // Continuation (续写) options
  continuationOptions: z
    .object({
      // dedicated model for tab completion and selection rewrite (Quick Ask's
      // "continue" mode uses the panel's own assistant model instead, see
      // QuickAskPanel's modelClient)
      continuationModelId: z.string().optional(),
      // enable selection chat (Cursor-like text selection actions)
      enableSelectionChat: z.boolean().optional(),
      // persist selected editor block highlight while chatting in sidebar
      persistSelectionHighlight: z.boolean().optional(),
      // enable manual context selection for continuation
      manualContextEnabled: z.boolean().optional(),
      // manual context folders picked by user from the vault
      manualContextFolders: z.array(z.string()).optional(),
      // folders that should be fully injected into continuation context
      referenceRuleFolders: z.array(z.string()).optional(),
      // override sampling parameters specifically for continuation
      temperature: z.number().min(0).max(2).optional(),
      topP: z.number().min(0).max(1).optional(),
      // enable or disable streaming responses for continuation results
      stream: z.boolean().optional(),
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
      // length preset for tab completion prompt constraints
      tabCompletionLengthPreset: z.enum(['short', 'medium', 'long']).optional(),
      // Quick Ask "continue" mode quick actions (chips shown when the
      // continue mode input is empty). Renamed from smartSpaceQuickActions
      // in v83->v84 — that name predated the Quick Ask "continue" mode and
      // referenced the now-removed Smart Space panel it originally belonged
      // to.
      continuationQuickActions: z
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
      // Selection Chat custom actions
      selectionChatActions: z
        .array(
          z.object({
            id: z.string(),
            label: z.string(),
            instruction: z.string(),
            mode: z
              .enum(['ask', 'rewrite', 'chat-input', 'chat-send'])
              .optional(),
            rewriteBehavior: z.enum(['custom', 'preset']).optional(),
            assistantId: z.string().optional(),
            enabled: z.boolean().default(true),
          }),
        )
        .optional(),
      // enable quick ask feature (@ trigger in empty line)
      enableQuickAsk: z.boolean().optional(),
      // trigger character for quick ask (default: @)
      quickAskTrigger: z.string().optional(),
      // Quick Ask mode. The UI only ever persists 'ask'/'agent'/'continue' —
      // 'edit' and 'edit-direct' are kept here only so a leftover legacy
      // value in an old data.json doesn't fail this whole continuationOptions
      // object's validation (see the single .catch() below). Callers
      // normalize any unrecognized value, including these legacy ones, to
      // 'ask'.
      quickAskMode: z
        .enum(['ask', 'edit', 'edit-direct', 'agent', 'continue'])
        .optional(),
      // auto dock quick ask to editor top right after sending
      quickAskAutoDockToTopRight: z.boolean().optional(),
      // quick ask context chars before cursor
      quickAskContextBeforeChars: z.number().int().min(0).optional(),
      // quick ask context chars after cursor
      quickAskContextAfterChars: z.number().int().min(0).optional(),
      // Knowledge bases the Sparkle panel's similar-notes list searches.
      // Undefined — the default — means every configured base, merged, and
      // stays that way as bases are added: "all" is a rule here, not a
      // snapshot of the ids that existed when the user chose it. A non-empty
      // list restricts the search to those bases; ids whose bases no longer
      // exist are dropped, and a selection left empty degrades back to "every
      // base" at query time (see `core/rag/similarNotes.ts`).
      similarNotesKnowledgeBaseIds: z.array(z.string()).optional(),
      // whether a failed streaming primary request should recover once with non-stream fallback
      streamFallbackRecoveryEnabled: z.boolean().optional(),
      // timeout for the primary request before recovery is considered
      primaryRequestTimeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(MAX_MODEL_REQUEST_TIMEOUT_MS)
        .optional(),
    })
    .catch({
      continuationModelId:
        DEFAULT_CHAT_MODELS.find((v) => v.id === DEFAULT_CHAT_TITLE_MODEL_ID)
          ?.id ?? '',
      enableSelectionChat: true,
      persistSelectionHighlight: true,
      manualContextEnabled: false,
      manualContextFolders: [],
      referenceRuleFolders: [],
      stream: true,
      maxContinuationChars: 8000,
      enableTabCompletion: false,
      tabCompletionModelId:
        DEFAULT_CHAT_MODELS.find((v) => v.id === DEFAULT_CHAT_TITLE_MODEL_ID)
          ?.id ?? '',
      tabCompletionOptions: { ...DEFAULT_TAB_COMPLETION_OPTIONS },
      tabCompletionTriggers: [...DEFAULT_TAB_COMPLETION_TRIGGERS],
      tabCompletionSystemPrompt: DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
      tabCompletionConstraints: '',
      tabCompletionLengthPreset: DEFAULT_TAB_COMPLETION_LENGTH_PRESET,
      continuationQuickActions: undefined,
      selectionChatActions: undefined,
      enableQuickAsk: true,
      quickAskTrigger: '@',
      quickAskMode: 'ask',
      quickAskAutoDockToTopRight: true,
      quickAskContextBeforeChars: 5000,
      quickAskContextAfterChars: 2000,
      similarNotesKnowledgeBaseIds: undefined,
      streamFallbackRecoveryEnabled: true,
      primaryRequestTimeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
    }),

  // Assistant list
  assistants: resilientArraySchema(assistantSchema),

  // Currently selected assistant ID
  currentAssistantId: z.string().optional(),

  // Quick Ask selected assistant ID
  quickAskAssistantId: z.string().optional(),
})
export type YoloSettings = z.infer<typeof yoloSettingsSchema>

export type SettingMigration = {
  fromVersion: number
  toVersion: number
  migrate: (data: Record<string, unknown>) => Record<string, unknown>
}
