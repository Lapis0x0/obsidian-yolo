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
import {
  VOICE_POLISH_PROMPT_MODES,
  type VoicePolishPromptMode,
} from './voicePromptPresets'

export {
  DEFAULT_VOICE_INPUT_SYSTEM_PROMPT,
  VOICE_POLISH_PROMPT_MODES,
  VOICE_POLISH_PROMPT_PRESETS,
} from './voicePromptPresets'
export type { VoicePolishPromptMode } from './voicePromptPresets'

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
 * Context-aware voice input. ASR configs can target OpenAI-compatible HTTP
 * endpoints or one of the supported WebSocket ASR protocols. The polish step
 * reuses the chat-model layer via `polishModelId`.
 *
 * Storage shape: users define a *list* of named ASR configs, each carrying
 * its own format + endpoint + audio-format hint. The active config is
 * referenced by `activeAsrConfigId`. This mirrors the provider/model
 * pattern: one outer list, no two-layer split, drag to reorder, gear to
 * edit. The pre-list shape (`selectedAsrApiFormat + asrProviderProfiles`,
 * which existed briefly during feature development on this branch) is
 * converted into list entries by the v64→v65 migration.
 */
export const ASR_API_FORMATS = [
  'openai-compatible-transcription',
  'openai-compatible-chat-audio-asr',
  'deepgram-compatible-websocket',
] as const
export type AsrApiFormat = (typeof ASR_API_FORMATS)[number]

/**
 * Outbound audio container override for Chat Audio.
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

export const ASR_WEBSOCKET_PROTOCOLS = [
  'deepgram-compatible',
  'whisperlivekit-native',
] as const
export type AsrWebSocketProtocol = (typeof ASR_WEBSOCKET_PROTOCOLS)[number]

export const ASR_CONFIG_CATEGORIES = [
  'http-short-audio',
  'http-long-audio',
  'websocket',
] as const
export type AsrConfigCategory = (typeof ASR_CONFIG_CATEGORIES)[number]

export const ASR_WEBSOCKET_FEATURE_MODES = ['auto', 'on', 'off'] as const
export type AsrWebSocketFeatureMode =
  (typeof ASR_WEBSOCKET_FEATURE_MODES)[number]

export const ASR_WEBSOCKET_FILE_STREAMING_RATE_MIN = 1
export const ASR_WEBSOCKET_FILE_STREAMING_RATE_MAX = 20
export const ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT = 2

/**
 * Network transport used for outbound ASR HTTP requests. Mirrors the LLM
 * provider's `requestTransportMode` enum so users do not have to learn a
 * second vocabulary for the same request layer.
 *
 * - `auto`: desktop Node fetch, then browser fetch on retryable
 *   network/CORS errors; mobile browser fetch, then Obsidian requestUrl.
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

export const VOICE_FLOATING_MODE_IDS = [
  'toggle-listen',
  'hold-to-talk',
  'audio-file',
  'read-aloud',
] as const
export type VoiceFloatingModeId = (typeof VOICE_FLOATING_MODE_IDS)[number]

export const TTS_API_FORMATS = [
  'openai-compatible-speech',
  'mimo-chat-audio-tts',
  'dashscope-cosyvoice',
] as const
export type TtsApiFormat = (typeof TTS_API_FORMATS)[number]

export const TTS_OUTPUT_FORMATS = [
  'mp3',
  'pcm',
  'wav',
  'pcm16',
  'opus',
  'aac',
  'flac',
] as const
export type TtsOutputFormat = (typeof TTS_OUTPUT_FORMATS)[number]

export const TTS_TRANSPORT_MODES = ASR_TRANSPORT_MODES
export type TtsTransportMode = (typeof TTS_TRANSPORT_MODES)[number]

export const READ_ALOUD_SOURCE_MODES = [
  'selection-or-document',
  'selection',
  'document',
] as const
export type ReadAloudSourceMode = (typeof READ_ALOUD_SOURCE_MODES)[number]

export const READ_ALOUD_MARKDOWN_MODES = ['readable', 'raw'] as const
export type ReadAloudMarkdownMode = (typeof READ_ALOUD_MARKDOWN_MODES)[number]
export const DEFAULT_READ_ALOUD_GENERATED_AUDIO_SAVE_DIR = 'YOLO/read_aloud'

/**
 * Single ASR configuration entry. Mirrors the provider/model pattern (one
 * flat outer list, no per-format sub-section). All format-specific fields
 * are colocated; the adapter reads the ones relevant for its `format`.
 *
 * IMPORTANT: this schema must keep `.catch` defaults on every field so
 * partial / older blobs survive load. The legacy `OpenAiCompatibleTranscriptionProfile`
 * and `OpenAiCompatibleChatAudioAsrProfile` shapes have been removed —
 * the v64→v65 migration converts them into entries of this schema.
 */
const asrConfigSchema = z
  .object({
    id: z.string(),
    name: z.string().catch(''),
    asrCategory: z.enum(ASR_CONFIG_CATEGORIES).catch('http-short-audio'),
    asrProvider: z.string().catch(''),
    format: z.enum(ASR_API_FORMATS).catch('openai-compatible-transcription'),
    baseURL: z.string().catch(''),
    apiKey: z.string().catch(''),
    apiSecret: z.string().catch(''),
    appId: z.string().catch(''),
    model: z.string().catch(''),
    transcriptionPath: z.string().catch(''),
    jobPath: z.string().catch(''),
    resultPath: z.string().catch(''),
    chatCompletionsPath: z.string().catch(''),
    audioContentFormat: z.string().catch('input_audio'),
    webSocketProtocol: z
      .enum(ASR_WEBSOCKET_PROTOCOLS)
      .or(
        z.string().transform((value) => {
          if (value === 'auto') return 'deepgram-compatible' as const
          return 'deepgram-compatible' as const
        }),
      )
      .catch('deepgram-compatible'),
    /** Deepgram-compatible /listen options. Ignored by other WS protocols. */
    webSocketPunctuate: z.boolean().catch(true),
    webSocketDiarizeMode: z.enum(ASR_WEBSOCKET_FEATURE_MODES).catch('off'),
    webSocketDictation: z.boolean().catch(false),
    /**
     * Max realtime multiplier when streaming an existing audio file into
     * WhisperLiveKit. Mic input is naturally realtime and ignores this.
     */
    webSocketFileStreamingRate: z
      .number()
      .min(ASR_WEBSOCKET_FILE_STREAMING_RATE_MIN)
      .max(ASR_WEBSOCKET_FILE_STREAMING_RATE_MAX)
      .catch(ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT),
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
      .catch('node'),
    language: z.string().catch('auto'),
    longAudioPunctuation: z.boolean().catch(true),
    longAudioDiarization: z.boolean().catch(true),
    longAudioSpeakerCount: z.number().int().min(0).max(32).catch(0),
    longAudioTimestamps: z.boolean().catch(true),
  })
  .catch({
    id: '',
    name: '',
    asrCategory: 'http-short-audio' as AsrConfigCategory,
    asrProvider: '',
    format: 'openai-compatible-transcription' as AsrApiFormat,
    baseURL: '',
    apiKey: '',
    apiSecret: '',
    appId: '',
    model: '',
    transcriptionPath: '',
    jobPath: '',
    resultPath: '',
    chatCompletionsPath: '',
    audioContentFormat: 'input_audio',
    webSocketProtocol: 'deepgram-compatible' as AsrWebSocketProtocol,
    webSocketPunctuate: true,
    webSocketDiarizeMode: 'off' as AsrWebSocketFeatureMode,
    webSocketDictation: false,
    webSocketFileStreamingRate: ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT,
    audioFormat: 'auto' as AsrAudioFormat,
    transportMode: 'node' as AsrTransportMode,
    language: 'auto',
    longAudioPunctuation: true,
    longAudioDiarization: true,
    longAudioSpeakerCount: 0,
    longAudioTimestamps: true,
  })

export type AsrConfig = z.infer<typeof asrConfigSchema>

const ttsConfigSchema = z
  .object({
    id: z.string(),
    name: z.string().catch(''),
    format: z.enum(TTS_API_FORMATS).catch('openai-compatible-speech'),
    baseURL: z.string().catch(''),
    apiKey: z.string().catch(''),
    model: z.string().catch(''),
    voice: z.string().catch(''),
    outputFormat: z.enum(TTS_OUTPUT_FORMATS).catch('mp3'),
    sampleRate: z.number().int().positive().nullable().catch(null),
    speed: z.number().positive().nullable().catch(null),
    pitch: z.number().nullable().catch(null),
    volume: z.number().nullable().catch(null),
    language: z.string().catch(''),
    styleInstruction: z.string().catch(''),
    transportMode: z.enum(TTS_TRANSPORT_MODES).catch('node'),
    requestPath: z.string().catch(''),
  })
  .catch({
    id: '',
    name: '',
    format: 'openai-compatible-speech' as TtsApiFormat,
    baseURL: '',
    apiKey: '',
    model: '',
    voice: '',
    outputFormat: 'mp3' as TtsOutputFormat,
    sampleRate: null,
    speed: null,
    pitch: null,
    volume: null,
    language: '',
    styleInstruction: '',
    transportMode: 'node' as TtsTransportMode,
    requestPath: '',
  })

export type TtsConfig = z.infer<typeof ttsConfigSchema>

export const AUDIO_FILE_CHUNK_HEADER_MODES = [
  'none',
  'local-start-time',
] as const
export type AudioFileChunkHeaderMode =
  (typeof AUDIO_FILE_CHUNK_HEADER_MODES)[number]

export const AUDIO_FILE_OUTPUT_METADATA_MODES = [
  'none',
  'metadata',
  'metadata-timestamps',
] as const
export type AudioFileOutputMetadataMode =
  (typeof AUDIO_FILE_OUTPUT_METADATA_MODES)[number]

const normalizeAudioFileOutputMetadataMode = (
  value: string,
): AudioFileOutputMetadataMode => {
  if (value === 'none') return 'none'
  if (value === 'title' || value === 'full' || value === 'metadata') {
    return 'metadata'
  }
  if (value === 'metadata-timestamps') return 'metadata-timestamps'
  return 'metadata-timestamps'
}

/**
 * How often the per-document summary should be regenerated while the user
 * keeps speaking into the same file. All summaries live in memory only — they
 * are never persisted, and they expire when Obsidian closes.
 *
 * - `smart`: default; refresh lazily when the document content itself changes
 *   substantially, without a fixed time interval.
 * - `session`: build the summary once on first need, then keep using it for
 *   the rest of this Obsidian session. Most conservative cost-wise.
 * - `15min` / `1hour`: time-based only; re-summarise after the given
 *   interval has elapsed since the last summary completed. Refreshing is lazy
 *   and only happens when voice input needs it.
 */
export const DOCUMENT_SUMMARY_REFRESH_MODES = [
  'smart',
  'session',
  '15min',
  '1hour',
] as const
export type DocumentSummaryRefreshMode =
  (typeof DOCUMENT_SUMMARY_REFRESH_MODES)[number]

export const DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS = {
  floatingIslandEnabled: true,
  floatingIslandModeOrder: [
    ...VOICE_FLOATING_MODE_IDS,
  ] as VoiceFloatingModeId[],
  floatingIslandHiddenModes: [] as VoiceFloatingModeId[],
  enabled: false,
  asrConfigs: [] as AsrConfig[],
  activeAsrConfigId: '',
  ttsConfigs: [] as TtsConfig[],
  activeTtsConfigId: '',
  polishModelId: '',
  // Polish is a low-creativity cleanup task; a small but non-zero
  // temperature reads better than greedy decoding without introducing
  // material hallucination risk. Null means use the selected polish model's
  // own configured temperature.
  polishTemperature: 0.2 as number | null,
  systemPromptMode: 'default' as VoicePolishPromptMode,
  customSystemPrompt: '',
  interactionMode: 'toggle-listen' as
    | 'toggle-listen'
    | 'hold-to-talk'
    | 'audio-file'
    | 'read-aloud',
  audioFileTranscriptionEnabled: false,
  voiceReadAloudEnabled: false,
  readAloudSourceMode: 'selection-or-document' as ReadAloudSourceMode,
  readAloudChunkTargetChars: 1000,
  readAloudPreloadSegments: 1,
  readAloudCacheEnabled: true,
  readAloudGeneratedAudioAutoSaveEnabled: true,
  readAloudGeneratedAudioSaveDir: DEFAULT_READ_ALOUD_GENERATED_AUDIO_SAVE_DIR,
  readAloudMarkdownMode: 'readable' as ReadAloudMarkdownMode,
  activeAudioFileAsrConfigId: '',
  audioFileChunkHeaderMode: 'none' as AudioFileChunkHeaderMode,
  audioFileOutputMetadataMode:
    'metadata-timestamps' as AudioFileOutputMetadataMode,
  audioFileFallbackNotePathTemplate:
    'Transcriptions/{{date}} {{time}} {{basename}}.md',
  audioFileChunkTargetDurationSec: 120,
  audioFileWavMaxDurationSec: 60 * 60,
  audioFileMaxConcurrentChunks: 5,
  audioFileChunkStartStaggerMs: 1500,
  audioFileChunkOverlapMs: 500,
  // Initial characters of editor text BEFORE the cursor handed to the polish
  // model. Voice prefix caching anchors this first window and lets it grow
  // naturally as accepted dictation adds text after the anchor.
  // (Field name kept for storage compatibility; the user-facing label is
  // "Initial before-cursor window".)
  contextRangeChars: 2000,
  // Characters of editor text AFTER the cursor handed to the polish model.
  // Independent from the before-cursor window above.
  maxAfterContextChars: 600,
  maxRecordingSeconds: 120,
  vadSpeechStartDecibels: -40,
  vadSilenceDecibels: -36,
  vadSpeechRequiredMs: 200,
  vadSilenceHoldMs: 1200,
  // Distance from the bottom of the active editor pane to the floating
  // island, expressed in vh so the same value reads similarly on a desktop
  // window and on a phone. 9vh keeps the bar clear of mobile OS gesture
  // areas / soft keyboards without floating awkwardly high on desktop.
  floatingIslandBottomOffsetVh: 9,
  // Empty string means "use the system default input device". When set to a
  // concrete deviceId we pass it to getUserMedia so the user can pin a
  // specific mic (USB headset, AirPods etc.) instead of whatever the OS
  // picks at the moment of recording.
  microphoneDeviceId: '',
  // Empty string means "use the system default output device". When the host
  // supports setSinkId, TTS tests and read-aloud playback can target a chosen
  // speaker/headset without changing the OS default.
  ttsOutputDeviceId: '',
  // Toggle-listen only: after the user Tab-accepts a polished draft, keep
  // the session alive and start the next recording segment automatically
  // (same UX as Wispr Flow / Superwhisper continuous dictation).
  autoRestartAfterAccept: false,
  // Include a per-document summary in the polish prompt so the model can
  // match terminology / topic over very long files. Cost-aware: summaries
  // are LLM-generated, in-memory only, and controlled from advanced settings.
  documentSummaryEnabled: true,
  documentSummaryRefreshMode: 'smart' as DocumentSummaryRefreshMode,
} as const

const contextVoiceInputOptionsSchema = z
  .object({
    floatingIslandEnabled: z.boolean().catch(true),
    floatingIslandModeOrder: z
      .array(z.enum(VOICE_FLOATING_MODE_IDS))
      .catch([...VOICE_FLOATING_MODE_IDS]),
    floatingIslandHiddenModes: z
      .array(z.enum(VOICE_FLOATING_MODE_IDS))
      .catch([]),
    enabled: z.boolean().catch(false),
    asrConfigs: z.array(asrConfigSchema).catch([]),
    activeAsrConfigId: z.string().catch(''),
    ttsConfigs: z.array(ttsConfigSchema).catch([]),
    activeTtsConfigId: z.string().catch(''),
    polishModelId: z.string().catch(''),
    polishTemperature: z
      .number()
      .min(0)
      .max(2)
      .nullable()
      .default(DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS.polishTemperature)
      .catch(DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS.polishTemperature),
    systemPromptMode: z.enum(VOICE_POLISH_PROMPT_MODES).catch('default'),
    customSystemPrompt: z.string().catch(''),
    interactionMode: z.enum(VOICE_FLOATING_MODE_IDS).catch('toggle-listen'),
    audioFileTranscriptionEnabled: z.boolean().catch(false),
    voiceReadAloudEnabled: z.boolean().catch(false),
    readAloudSourceMode: z
      .enum(READ_ALOUD_SOURCE_MODES)
      .catch(DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS.readAloudSourceMode),
    readAloudChunkTargetChars: z.number().int().min(200).max(6000).catch(1000),
    readAloudPreloadSegments: z.number().int().min(0).max(3).catch(1),
    readAloudCacheEnabled: z.boolean().catch(true),
    readAloudGeneratedAudioAutoSaveEnabled: z.boolean().catch(true),
    readAloudGeneratedAudioSaveDir: z
      .string()
      .catch(
        DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS.readAloudGeneratedAudioSaveDir,
      ),
    readAloudMarkdownMode: z.enum(READ_ALOUD_MARKDOWN_MODES).catch('readable'),
    activeAudioFileAsrConfigId: z.string().catch(''),
    audioFileChunkHeaderMode: z
      .enum(AUDIO_FILE_CHUNK_HEADER_MODES)
      .catch(DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS.audioFileChunkHeaderMode),
    audioFileOutputMetadataMode: z
      .enum(AUDIO_FILE_OUTPUT_METADATA_MODES)
      .or(z.string().transform(normalizeAudioFileOutputMetadataMode))
      .catch(DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS.audioFileOutputMetadataMode),
    audioFileFallbackNotePathTemplate: z
      .string()
      .catch(
        DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS.audioFileFallbackNotePathTemplate,
      ),
    audioFileChunkTargetDurationSec: z
      .number()
      .int()
      .min(15)
      .max(600)
      .catch(
        DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS.audioFileChunkTargetDurationSec,
      ),
    audioFileWavMaxDurationSec: z
      .number()
      .int()
      .min(30)
      .max(2 * 60 * 60)
      .catch(DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS.audioFileWavMaxDurationSec),
    audioFileMaxConcurrentChunks: z
      .number()
      .int()
      .min(1)
      .max(5)
      .catch(DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS.audioFileMaxConcurrentChunks),
    audioFileChunkStartStaggerMs: z
      .number()
      .int()
      .min(1000)
      .max(3000)
      .catch(DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS.audioFileChunkStartStaggerMs),
    audioFileChunkOverlapMs: z
      .number()
      .int()
      .min(0)
      .max(1500)
      .catch(DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS.audioFileChunkOverlapMs),
    contextRangeChars: z.number().int().min(0).catch(2000),
    maxAfterContextChars: z.number().int().min(0).catch(600),
    maxRecordingSeconds: z.number().int().min(5).max(900).catch(120),
    vadSpeechStartDecibels: z.number().min(-50).max(-5).catch(-40),
    vadSilenceDecibels: z.number().min(-50).max(-5).catch(-36),
    vadSpeechRequiredMs: z.number().int().min(50).max(2000).catch(200),
    vadSilenceHoldMs: z.number().int().min(300).max(5000).catch(1200),
    floatingIslandBottomOffsetVh: z.number().min(0).max(50).catch(9),
    microphoneDeviceId: z.string().catch(''),
    ttsOutputDeviceId: z.string().catch(''),
    autoRestartAfterAccept: z.boolean().catch(false),
    documentSummaryEnabled: z
      .boolean()
      .catch(DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS.documentSummaryEnabled),
    documentSummaryRefreshMode: z
      .enum(DOCUMENT_SUMMARY_REFRESH_MODES)
      .catch(DEFAULT_CONTEXT_VOICE_INPUT_OPTIONS.documentSummaryRefreshMode),
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

  // Context-aware voice input
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
