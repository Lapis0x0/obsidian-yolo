import { z } from 'zod'

import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_CHAT_TITLE_MODEL_ID,
} from '../../constants'
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

import { SETTINGS_SCHEMA_VERSION } from './migrations'

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
  excludePatterns: z.array(z.string()).catch([]),
  includePatterns: z.array(z.string()).catch([]),
  /** When true, index `.pdf` files for RAG (text extraction). */
  indexPdf: z.boolean().catch(true),
  // auto update options
  autoUpdateEnabled: z.boolean().catch(true),
  autoUpdateIntervalHours: z.number().catch(0),
  lastAutoUpdateAt: z.number().catch(0),
})

type TabCompletionOptionDefaults = {
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
  idleTriggerEnabled: false,
  autoTriggerDelayMs: 3000,
  autoTriggerCooldownMs: 15000,
  triggerDelayMs: 3000,
  minContextLength: 20,
  contextRange: 4000, // Total context chars, split 4:1 (3200 before, 800 after)
  maxSuggestionLength: 2000,
  temperature: 0.5,
  requestTimeoutMs: 12000,
  // Tab 补全是延迟敏感场景，默认关闭推理；用户可在设置中改为 low / auto 以适配强制推理的模型（如 gpt-oss）
  reasoningLevel: 'off',
}

export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 60000

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
  allowExternalScripts: z.boolean().optional(),
  // Execution timeout cap, in milliseconds. The LLM may pass a smaller
  // timeoutMs in its tool args, but the host clamps the effective value
  // to this cap. Undefined means use the built-in default.
  timeoutMs: z.number().optional(),
  // Maximum rows returned by $db.search / $db.find. The LLM may request a
  // smaller limit per call but never larger. Undefined falls back to a
  // built-in default.
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
    description: z.string().optional(),
  })
  .catch({
    id: '',
    type: 'string',
    pattern: '',
    enabled: true,
  })

/**
 * Context-aware voice input (Slice A). Two OpenAI-compatible ASR API formats
 * are wired here; WebSocket / FunASR is reserved as a future format value but
 * not implemented in Slice A. The polish step reuses the chat-model layer via
 * `polishModelId`.
 *
 * Storage shape: users define a *list* of named ASR configs, each carrying
 * its own format + endpoint + audio-format hint. The active config is
 * referenced by `activeAsrConfigId`. This mirrors the provider/model
 * pattern: one outer list, no two-layer split, drag to reorder, gear to
 * edit. The pre-list shape (`selectedAsrApiFormat + asrProviderProfiles`,
 * which existed briefly during feature development on this branch) is
 * converted into list entries by the 62→63 migration.
 */
export const ASR_API_FORMATS = [
  'openai-compatible-transcription',
  'openai-compatible-chat-audio-asr',
] as const
export type AsrApiFormat = (typeof ASR_API_FORMATS)[number]

/**
 * Outbound audio container override for chat-audio ASR.
 *
 * - `auto`: send whatever MediaRecorder captured (typically webm/opus). Works
 *   for OpenAI gpt-4o-audio, Qwen3-ASR, FireRedASR2.
 * - `wav`: client-side decode → linear PCM → 16-bit WAV. Required by Google
 *   Gemini's chat-audio endpoint which rejects webm with
 *   "Invalid audio format. Valid formats are: [wav, mp3]". WAV is also lossless
 *   re-packaging of the captured PCM, so no extra ASR quality hit.
 *
 * We deliberately do not offer mp3: a browser-side mp3 encoder would add
 * ~150 KB to the bundle and ~hundreds of ms of main-thread work per clip,
 * for no benefit at the voice-input clip lengths this feature targets.
 */
export const ASR_AUDIO_FORMATS = ['auto', 'wav'] as const
export type AsrAudioFormat = (typeof ASR_AUDIO_FORMATS)[number]

/**
 * Network transport used for outbound ASR HTTP requests. Mirrors the LLM
 * provider's `requestTransportMode` enum so users do not have to learn a
 * second vocabulary for the same request layer.
 *
 * - `auto`: browser fetch, then desktop Node fetch, then Obsidian requestUrl
 *   on CORS/network errors.
 * - `obsidian`: Obsidian's `requestUrl`. Bypasses CORS/proxy issues.
 * - `browser`: native `window.fetch`. Honours AbortSignal, useful for
 *   endpoints that the Electron requestUrl shim mishandles (rare, but a few
 *   enterprise gateways strip headers).
 * - `node`: desktop Node fetch, lazy-loaded on desktop only, with the same
 *   proxy-aware fetch path used by LLM providers; mobile falls back to
 *   `obsidian`.
 */
export const ASR_TRANSPORT_MODES = [
  'auto',
  'obsidian',
  'browser',
  'node',
] as const
export type AsrTransportMode = (typeof ASR_TRANSPORT_MODES)[number]

/**
 * System-prompt presets for the voice polish step. Picking anything other
 * than `custom` swaps in a built-in starter prompt; `custom` exposes the
 * textarea so users can type their own. Presets are baked into
 * `VOICE_POLISH_PROMPT_PRESETS` below to keep the dropdown and the prompt
 * source in lockstep.
 */
export const VOICE_POLISH_PROMPT_MODES = [
  'default',
  'translate',
  'expand',
  'list',
  'custom',
] as const
export type VoicePolishPromptMode = (typeof VOICE_POLISH_PROMPT_MODES)[number]

export const DEFAULT_VOICE_INPUT_SYSTEM_PROMPT = `You polish a single speech-to-text transcript into text that is ready to insert at the user's current cursor position.

Hard rules:
- Output strict JSON matching this TypeScript type and nothing else, no Markdown fences, no commentary:
  { "action": "insert_at_cursor" | "insert_after_selection" | "replace_selection" | "cancel_input", "text": string }
- "text" must contain only the characters to insert (or "" when action is "cancel_input").
- Keep the user's language; do not translate unless explicitly asked.
- Fix ASR slips (homophones, missing punctuation, filler words) but keep the user's meaning, tone and intent.
- Honour spoken self-corrections like "not A, B" or "scratch that, say <X>" — emit only the corrected version, never both.
- If the transcript is a directive about this very recording — e.g. "cancel", "never mind", "don't insert that", "forget it" — return { "action": "cancel_input", "text": "" }.
- If the transcript is a directive about how to transform this very recording — e.g. "translate to English", "make it a bullet list", "rewrite formally" — apply the directive to the rest of the transcript and emit only the resulting text.
- If the user has a selection and the transcript is naturally a replacement of that selection, choose "replace_selection". If it should follow the selection, choose "insert_after_selection". Otherwise choose "insert_at_cursor".
- When the intent is ambiguous between writing-as-content and giving-a-directive, default to writing-as-content so the user's words are not silently dropped.
- Respect the surrounding Markdown structure (list continuation, code fences, headings) when picking spacing and prefixes for "text".`

/**
 * Built-in prompt presets for voice polish. Each preset is a fully-formed
 * system prompt — picking it from the dropdown replaces the active polish
 * prompt directly (no extra textarea step). `custom` is the escape hatch
 * that surfaces the user's editable prompt instead.
 */
export const VOICE_POLISH_PROMPT_PRESETS: Record<
  Exclude<VoicePolishPromptMode, 'custom'>,
  string
> = {
  default: DEFAULT_VOICE_INPUT_SYSTEM_PROMPT,
  translate: `Translate a single speech-to-text transcript into the OPPOSITE of its detected language (Chinese ⇆ English). Output the translated text only, never both versions.

Output strict JSON: { "action": "insert_at_cursor" | "insert_after_selection" | "replace_selection" | "cancel_input", "text": string }
- "text" holds the translated output only, in the target language.
- If the transcript is a cancel directive ("cancel", "never mind", "scratch that"), return { "action": "cancel_input", "text": "" }.
- If the user has a selection and the transcript reads as a replacement, choose "replace_selection"; otherwise "insert_at_cursor".

Examples:
  transcript: "你好世界"     → { "action": "insert_at_cursor", "text": "Hello world" }
  transcript: "scrap that"   → { "action": "cancel_input", "text": "" }`,
  expand: `Treat a single speech-to-text transcript as an outline / bullet idea and expand it into a coherent paragraph that fits at the user's cursor.

Output strict JSON: { "action": "insert_at_cursor" | "insert_after_selection" | "replace_selection" | "cancel_input", "text": string }
- Keep the user's language. Maintain surrounding Markdown / list / heading structure.
- If the transcript is a cancel directive, return { "action": "cancel_input", "text": "" }.`,
  list: `Convert a single speech-to-text transcript into a Markdown bullet list ready to drop at the user's cursor.

Output strict JSON: { "action": "insert_at_cursor" | "insert_after_selection" | "replace_selection" | "cancel_input", "text": string }
- Each top-level item starts with "- " on its own line.
- Keep the user's language. Strip filler words ("um", "you know", etc.).
- If the transcript is a cancel directive, return { "action": "cancel_input", "text": "" }.`,
}

/**
 * Single ASR configuration entry. Mirrors the provider/model pattern (one
 * flat outer list, no per-format sub-section). All format-specific fields
 * are colocated; the adapter reads the ones relevant for its `format`.
 *
 * IMPORTANT: this schema must keep `.catch` defaults on every field so
 * partial / older blobs survive load. The legacy `OpenAiCompatibleTranscriptionProfile`
 * and `OpenAiCompatibleChatAudioAsrProfile` shapes have been removed —
 * the v63→v64 migration converts them into entries of this schema.
 */
const asrConfigSchema = z
  .object({
    id: z.string(),
    name: z.string().catch(''),
    format: z.enum(ASR_API_FORMATS).catch('openai-compatible-transcription'),
    baseURL: z.string().catch(''),
    apiKey: z.string().catch(''),
    model: z.string().catch(''),
    transcriptionPath: z.string().catch(''),
    chatCompletionsPath: z.string().catch(''),
    audioContentFormat: z.string().catch('input_audio'),
    /** See `ASR_AUDIO_FORMATS` for semantics. Only relevant to chat-audio. */
    audioFormat: z.enum(ASR_AUDIO_FORMATS).catch('auto'),
    /** Outbound HTTP transport. See `ASR_TRANSPORT_MODES`. */
    transportMode: z
      .enum(ASR_TRANSPORT_MODES)
      // Accept the legacy names that briefly existed during feature dev so
      // testers on the branch don't see their setting silently reset.
      .or(
        z.string().transform((v) => {
          if (v === 'requestUrl') return 'obsidian' as const
          if (v === 'fetch') return 'browser' as const
          return 'obsidian' as const
        }),
      )
      .catch('auto'),
    language: z.string().catch('auto'),
  })
  .catch({
    id: '',
    name: '',
    format: 'openai-compatible-transcription' as AsrApiFormat,
    baseURL: '',
    apiKey: '',
    model: '',
    transcriptionPath: '',
    chatCompletionsPath: '',
    audioContentFormat: 'input_audio',
    audioFormat: 'auto' as AsrAudioFormat,
    transportMode: 'auto' as AsrTransportMode,
    language: 'auto',
  })

export type AsrConfig = z.infer<typeof asrConfigSchema>

export const DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS = {
  enabled: false,
  asrConfigs: [] as AsrConfig[],
  activeAsrConfigId: '',
  lastAsrTestStatus: 'untested' as 'untested' | 'passed' | 'failed',
  lastAsrTestMessage: '',
  polishModelId: '',
  polishTemperature: undefined as number | undefined,
  systemPromptMode: 'default' as VoicePolishPromptMode,
  customSystemPrompt: '',
  interactionMode: 'toggle-listen' as 'toggle-listen' | 'hold-to-talk',
  pauseTabCompletionWhileListening: true,
  contextRangeChars: 2000,
  maxAfterContextChars: 600,
  maxRecordingSeconds: 120,
  vadSpeechStartDecibels: -42,
  vadSilenceDecibels: -38,
  vadSilenceHoldMs: 1200,
  rawAudioSaveMode: 'never' as const,
  // Empty string means "use the system default input device". When set to a
  // concrete deviceId we pass it to getUserMedia so the user can pin a
  // specific mic (USB headset, AirPods etc.) instead of whatever the OS
  // picks at the moment of recording.
  microphoneDeviceId: '',
} as const

const contextVoiceInputOptionsSchema = z
  .object({
    enabled: z.boolean().catch(false),
    asrConfigs: z.array(asrConfigSchema).catch([]),
    activeAsrConfigId: z.string().catch(''),
    lastAsrTestStatus: z
      .enum(['untested', 'passed', 'failed'])
      .catch('untested'),
    lastAsrTestMessage: z.string().catch(''),
    polishModelId: z.string().catch(''),
    polishTemperature: z.number().min(0).max(2).optional().catch(undefined),
    systemPromptMode: z.enum(VOICE_POLISH_PROMPT_MODES).catch('default'),
    customSystemPrompt: z.string().catch(''),
    interactionMode: z
      .enum(['toggle-listen', 'hold-to-talk'])
      .catch('toggle-listen'),
    pauseTabCompletionWhileListening: z.boolean().catch(true),
    contextRangeChars: z.number().int().min(0).catch(2000),
    maxAfterContextChars: z.number().int().min(0).catch(600),
    maxRecordingSeconds: z.number().int().min(5).max(900).catch(120),
    vadSpeechStartDecibels: z.number().min(-90).max(0).catch(-42),
    vadSilenceDecibels: z.number().min(-90).max(0).catch(-38),
    vadSilenceHoldMs: z.number().int().min(300).max(5000).catch(1200),
    rawAudioSaveMode: z.literal('never').catch('never'),
    microphoneDeviceId: z.string().catch(''),
  })
  .catch({ ...DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS })

export type ContextVoiceInputOptions = z.infer<
  typeof contextVoiceInputOptionsSchema
>

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
  chatTitleModelId: z.string().catch(''), // model for automatic conversation naming and compact summaries
  embeddingModelId: z.string().catch(''), // model for embedding

  // System Prompt
  systemPrompt: z.string().catch(''),

  // RAG Options
  ragOptions: ragOptionsSchema.catch({
    enabled: true,
    chunkSize: 1000,
    thresholdTokens: 20000,
    minSimilarity: 0.0,
    limit: 10,
    embeddingConcurrency: 10,
    excludePatterns: [],
    includePatterns: [],
    indexPdf: true,
    autoUpdateEnabled: true,
    autoUpdateIntervalHours: 0,
    lastAutoUpdateAt: 0,
  }),

  // MCP configuration
  mcp: z
    .object({
      servers: resilientArraySchema(mcpServerConfigSchema),
      builtinToolOptions: mcpServerToolOptionsSchema.catch({}),
      enableToolDisclosure: z.boolean().catch(false),
    })
    .catch({
      servers: [],
      builtinToolOptions: {},
      enableToolDisclosure: false,
    }),

  // JS sandbox (js_eval) configuration. Global because the capability surface
  // (network / vault read / $db / external scripts) is sensitive enough that
  // we don't want it implicitly varying per agent — toggling any extension
  // capability forces approval for every agent that has js_eval enabled.
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
      chatInputHeight: z.number().int().min(80).max(520).optional(),
      chatApplyMode: z.enum(['review-required', 'direct-apply']).optional(),
      chatTitlePrompt: z.string().optional(),
      // Chat mode (chat/agent)
      chatMode: z.enum(['chat', 'agent']).optional(),
      // Whether the user has acknowledged the first-time agent mode warning
      agentModeWarningConfirmed: z.boolean().optional(),
      // Persist preferred reasoning level per model id in Chat input
      reasoningLevelByModelId: z
        .record(z.string(), z.enum(REASONING_LEVELS))
        .optional(),
      // Collapse older non-pinned conversations into an archive group
      historyArchiveEnabled: z.boolean().optional(),
      // Maximum number of recent non-pinned conversations shown before archive
      historyArchiveThreshold: z.number().int().min(20).max(500).optional(),
      // Auto context compaction before next user send (based on last assistant usage)
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
      // Where the ribbon icon should open the Chat view
      ribbonClickAction: z
        .enum(['sidebar', 'tab', 'split', 'window', 'last'])
        .optional(),
      // Last placement actually used to open a chat leaf; only consulted when
      // `ribbonClickAction === 'last'`
      lastChatPlacement: z
        .enum(['sidebar', 'tab', 'split', 'window'])
        .optional(),
    })
    .catch({
      includeCurrentFileContent: true,
      mentionDisplayMode: 'inline',
      mentionContextMode: 'light',
      chatInputHeight: undefined,
      chatApplyMode: 'review-required',
      chatTitlePrompt: '',
      chatMode: 'agent',
      agentModeWarningConfirmed: false,
      reasoningLevelByModelId: {},
      historyArchiveEnabled: true,
      historyArchiveThreshold: 50,
      autoContextCompactionEnabled: false,
      autoContextCompactionThresholdMode: 'tokens',
      autoContextCompactionThresholdTokens: 24000,
      autoContextCompactionThresholdRatio: 0.8,
      chatFontScale: undefined,
      imageReadingEnabled: true,
      imageCompressionEnabled: true,
      imageCompressionQuality: 85,
      externalImageFetchEnabled: false,
      ribbonClickAction: 'sidebar',
      lastChatPlacement: undefined,
    }),

  notificationOptions: notificationOptionsSchema,

  // Continuation (续写) options
  continuationOptions: z
    .object({
      // dedicated continuation model
      continuationModelId: z.string().optional(),
      // enable smart space quick invoke
      enableSmartSpace: z.boolean().optional(),
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
      // folders used as the scoped knowledge base for RAG retrieval
      knowledgeBaseFolders: z.array(z.string()).optional(),
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
      // quick ask mode: support legacy ask/edit values and current chat/agent values
      quickAskMode: z
        .enum(['ask', 'edit', 'edit-direct', 'chat', 'agent'])
        .optional(),
      // auto dock quick ask to editor top right after sending
      quickAskAutoDockToTopRight: z.boolean().optional(),
      // quick ask context chars before cursor
      quickAskContextBeforeChars: z.number().int().min(0).optional(),
      // quick ask context chars after cursor
      quickAskContextAfterChars: z.number().int().min(0).optional(),
      // whether a failed streaming primary request should recover once with non-stream fallback
      streamFallbackRecoveryEnabled: z.boolean().optional(),
      // timeout for the primary request before recovery is considered
      primaryRequestTimeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(600000)
        .optional(),
    })
    .catch({
      continuationModelId:
        DEFAULT_CHAT_MODELS.find((v) => v.id === DEFAULT_CHAT_TITLE_MODEL_ID)
          ?.id ?? '',
      enableSmartSpace: true,
      enableSelectionChat: true,
      persistSelectionHighlight: true,
      manualContextEnabled: false,
      manualContextFolders: [],
      referenceRuleFolders: [],
      knowledgeBaseFolders: [],
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
      smartSpaceQuickActions: undefined,
      selectionChatActions: undefined,
      smartSpaceTriggerMode: 'single-space',
      smartSpaceUseWebSearch: false,
      smartSpaceUseUrlContext: false,
      enableQuickAsk: true,
      quickAskTrigger: '@',
      quickAskMode: 'chat',
      quickAskAutoDockToTopRight: true,
      quickAskContextBeforeChars: 5000,
      quickAskContextAfterChars: 2000,
      streamFallbackRecoveryEnabled: true,
      primaryRequestTimeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
    }),

  // Context-aware voice input (Slice A)
  contextVoiceInputOptions: contextVoiceInputOptionsSchema,

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
