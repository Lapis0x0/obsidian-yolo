import { executeSingleTurn } from '../../../core/ai/single-turn'
import { getChatModelClient } from '../../../core/llm/manager'
import { promoteProviderTransportModeToObsidian } from '../../../core/llm/transportModePromotion'
import type {
  DocumentSummaryRefreshMode,
  YoloSettings,
} from '../../../settings/schema/setting.types'
import type { LLMRequestBase } from '../../../types/llm/request'

/**
 * Per-document summary cache for the voice-input polish prompt.
 *
 * Goals:
 *   - In-memory only. Never persisted, never written to disk. Vault-side
 *     summaries are throwaway state.
 *   - One entry per file path. Two different open files do not share state.
 *   - Lazy: a polish call calls `getSummary()` which returns the freshest
 *     usable summary *right now* (possibly null) and schedules a regeneration
 *     in the background if the cache is stale. The polish call NEVER waits
 *     for a summary — the voice-input latency budget comes first.
 *   - Warming: `warm()` is called when the user starts recording (not when
 *     polish first needs the summary), so the first polish has the best
 *     chance of finding a fresh cache entry without paying the round trip.
 *   - Refresh modes: 'session' (build once per Obsidian session and reuse),
 *     '15min', '1hour'. The TTL is checked against the timestamp of the
 *     LAST successful summary; while a regeneration is in flight, the stale
 *     summary keeps being served so we don't flap to null.
 *   - Long documents are chunked-by-truncation: we cap the prompt input at
 *     `MAX_SUMMARY_INPUT_CHARS`. Anything past that gets dropped (with an
 *     elided-tail marker) rather than attempting hierarchical merge — the
 *     summary is a hint, not ground truth, so a tail-truncated summary is
 *     still useful.
 *
 * Output structure:
 *   - The summary is a JSON object { summary, hotWords } where hotWords are
 *     ASR-confusable terms (proper nouns, technical jargon, IDs) extracted
 *     from the document. Hot words are fed to the polish prompt so the
 *     model knows to be cautious with their spelling. Future: feed the
 *     same hot-word list to the ASR endpoint as a vocabulary hint.
 */

const MAX_SUMMARY_INPUT_CHARS = 20000
const MAX_SUMMARY_OUTPUT_CHARS = 1200
const MAX_HOT_WORDS = 30

const REFRESH_INTERVAL_MS: Record<DocumentSummaryRefreshMode, number> = {
  session: Number.POSITIVE_INFINITY,
  '15min': 15 * 60 * 1000,
  '1hour': 60 * 60 * 1000,
}

export type DocumentSummaryResult = {
  /** Free-form summary text (in the source document's language). */
  summary: string
  /** ASR-confusable terms extracted from the document; may be empty. */
  hotWords: string[]
}

type CacheEntry = {
  filePath: string
  /** Text of the file that produced `summary`. Used to detect drift. */
  contentHash: string
  /** Last produced result. Both fields may be empty if generation returned nothing. */
  result: DocumentSummaryResult
  /** Wall-clock ms when this entry's result completed. */
  generatedAt: number
  /** In-flight regeneration so concurrent callers reuse the same request. */
  inFlight: Promise<DocumentSummaryResult | null> | null
}

const EMPTY_RESULT: DocumentSummaryResult = { summary: '', hotWords: [] }

export type DocumentSummaryManagerDeps = {
  getSettings: () => YoloSettings
  setSettings: (next: YoloSettings) => Promise<void>
}

export class DocumentSummaryManager {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly deps: DocumentSummaryManagerDeps) {}

  /**
   * Return the currently-best summary+hotWords for `filePath`, if any. Never
   * blocks on generation. When the cache is stale (or missing) we schedule
   * a background refresh so the next caller has fresh data.
   *
   * Returns `null` when:
   *   - The feature is disabled in settings.
   *   - No polish model is configured.
   *   - The file is empty or there is no usable file path.
   *   - No summary has ever been produced for this file yet (the first call
   *     will kick off generation; the next call will get the result).
   */
  getSummary(input: {
    filePath: string
    content: string
  }): DocumentSummaryResult | null {
    return this.lookup(input, { triggerIfStale: true })
  }

  /**
   * Kick off summary generation in the background without returning a value.
   * Called from the controller when the user starts a recording, so the
   * first polish in the session has the best chance of finding a fresh
   * cache entry. Safe to call repeatedly — the in-flight slot deduplicates.
   */
  warm(input: { filePath: string; content: string }): void {
    this.lookup(input, { triggerIfStale: true })
  }

  /**
   * Forget the summary for a file path, or every cached file under a folder
   * path. Safe to call on a path that was never summarised.
   */
  forget(filePath: string): void {
    if (!filePath) return
    const childPrefix = `${filePath}/`
    for (const key of this.cache.keys()) {
      if (key === filePath || key.startsWith(childPrefix)) {
        this.cache.delete(key)
      }
    }
  }

  /** Wipe everything (e.g. plugin shutdown). */
  clear(): void {
    this.cache.clear()
  }

  private lookup(
    input: { filePath: string; content: string },
    options: { triggerIfStale: boolean },
  ): DocumentSummaryResult | null {
    const settings = this.deps.getSettings()
    const voice = settings.contextVoiceInputOptions
    if (!voice?.documentSummaryEnabled) return null
    if (!input.filePath || input.content.trim().length === 0) return null

    const refreshMode = voice.documentSummaryRefreshMode ?? '1hour'
    const intervalMs =
      REFRESH_INTERVAL_MS[refreshMode] ?? Number.POSITIVE_INFINITY
    const contentHash = hashContent(input.content)
    const now = Date.now()
    const entry = this.cache.get(input.filePath)

    // Time-based refresh ONLY. Content drift between recordings does not
    // automatically trigger a re-summarisation — that would let the user's
    // own typing burn LLM calls and would ignore the 'session' setting (a
    // mode the user explicitly asked us to honour as "don't refresh until
    // the next session"). The contentHash stays in the cache purely as a
    // tag so a later eviction policy can tell summaries apart.
    const expired = entry && now - entry.generatedAt > intervalMs

    if (entry && !expired) {
      return entry.result
    }

    if (options.triggerIfStale && !entry?.inFlight) {
      this.scheduleSummary({
        filePath: input.filePath,
        content: input.content,
        contentHash,
      })
    }

    // Serve the previous result while a refresh is in flight; otherwise null.
    if (entry) {
      return entry.result
    }
    return null
  }

  private scheduleSummary(input: {
    filePath: string
    content: string
    contentHash: string
  }): void {
    const existing = this.cache.get(input.filePath)
    const inFlight = this.runSummary(input)
    const stub: CacheEntry = existing ?? {
      filePath: input.filePath,
      contentHash: input.contentHash,
      result: EMPTY_RESULT,
      generatedAt: 0,
      inFlight: null,
    }
    stub.inFlight = inFlight
    this.cache.set(input.filePath, stub)
    void inFlight
      .then((result) => {
        const current = this.cache.get(input.filePath)
        if (current?.inFlight !== inFlight) return
        if (result === null) {
          // Generation failed; keep the previous result in place so the next
          // call still has something to serve.
          current.inFlight = null
          return
        }
        this.cache.set(input.filePath, {
          filePath: input.filePath,
          contentHash: input.contentHash,
          result,
          generatedAt: Date.now(),
          inFlight: null,
        })
      })
      .catch(() => {
        const current = this.cache.get(input.filePath)
        if (current?.inFlight === inFlight) current.inFlight = null
      })
  }

  private async runSummary(input: {
    filePath: string
    content: string
    contentHash: string
  }): Promise<DocumentSummaryResult | null> {
    try {
      const settings = this.deps.getSettings()
      const voice = settings.contextVoiceInputOptions
      const modelId = pickSummaryModelId(settings)
      if (!modelId) return null

      const { providerClient, model } = getChatModelClient({
        settings,
        modelId,
        onAutoPromoteTransportMode: (providerId, mode) => {
          void promoteProviderTransportModeToObsidian({
            getSettings: this.deps.getSettings,
            setSettings: this.deps.setSettings,
            providerId,
            mode,
          })
        },
      })

      const body =
        input.content.length > MAX_SUMMARY_INPUT_CHARS
          ? input.content.slice(0, MAX_SUMMARY_INPUT_CHARS) +
            '\n\n…(later content truncated for summarisation)'
          : input.content

      const summaryWordLimit = Math.floor(MAX_SUMMARY_OUTPUT_CHARS / 4)
      const systemPrompt = `Summarise the following note so that a voice-input polish model can match its terminology and tone, and extract ASR-confusable terms.

Output strict JSON (no Markdown fences, no commentary):
  { "summary": string, "hotWords": string[] }

Rules:
- "summary": prose summary under ${summaryWordLimit} words, in the source document's language. Surface domain-specific terms, named entities, and the writing style. Do NOT invent content not present in the source. If the note is empty or only headings, briefly say so.
- "hotWords": up to ${MAX_HOT_WORDS} short terms (1-4 words each) that an ASR engine might mishear or misspell — proper nouns, technical jargon, project / product / personal names, abbreviations, IDs, file names. Use the EXACT spelling and capitalisation that appears in the source. Empty array is fine if the document has no such terms.`

      const request: LLMRequestBase = {
        model: model.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: body },
        ],
        reasoningLevel: 'off',
      }
      if (typeof voice?.polishTemperature === 'number') {
        request.temperature = Math.min(Math.max(voice.polishTemperature, 0), 2)
      }

      const result = await executeSingleTurn({
        providerClient,
        model,
        request,
        stream: false,
        primaryRequestTimeoutMs:
          settings.continuationOptions?.primaryRequestTimeoutMs,
        streamFallbackRecoveryEnabled: false,
        purpose: 'auxiliary',
      })
      return parseSummaryResponse(result.content ?? '')
    } catch (error) {
      console.warn('Voice-input document summary generation failed:', error)
      return null
    }
  }
}

const pickSummaryModelId = (settings: YoloSettings): string | null => {
  const voice = settings.contextVoiceInputOptions
  if (voice?.polishModelId && voice.polishModelId.trim().length > 0) {
    return voice.polishModelId
  }
  const continuation =
    settings.continuationOptions?.continuationModelId ??
    settings.continuationOptions?.tabCompletionModelId ??
    ''
  if (continuation.trim().length > 0) return continuation
  if (settings.chatTitleModelId?.trim().length > 0) {
    return settings.chatTitleModelId
  }
  if (settings.chatModelId?.trim().length > 0) return settings.chatModelId
  return null
}

const stripFences = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const lines = trimmed.split('\n')
  if (lines.length === 0) return trimmed
  lines.shift()
  if (lines.length > 0 && lines[lines.length - 1].startsWith('```')) {
    lines.pop()
  }
  return lines.join('\n').trim()
}

const parseSummaryResponse = (rawContent: string): DocumentSummaryResult => {
  const stripped = stripFences(rawContent)
  try {
    const parsed: unknown = JSON.parse(stripped)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as { summary?: unknown; hotWords?: unknown }
      const summary =
        typeof obj.summary === 'string'
          ? obj.summary.trim().slice(0, MAX_SUMMARY_OUTPUT_CHARS)
          : ''
      const hotWords: string[] = []
      if (Array.isArray(obj.hotWords)) {
        const seen = new Set<string>()
        for (const item of obj.hotWords) {
          if (typeof item !== 'string') continue
          const trimmed = item.trim()
          if (trimmed.length === 0 || trimmed.length > 40) continue
          const key = trimmed.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          hotWords.push(trimmed)
          if (hotWords.length >= MAX_HOT_WORDS) break
        }
      }
      return { summary, hotWords }
    }
  } catch {
    // Fall through; treat as plain-text summary with no hot words.
  }
  // Plain-text fallback: model ignored the JSON schema. Salvage as summary.
  return {
    summary: stripped.slice(0, MAX_SUMMARY_OUTPUT_CHARS),
    hotWords: [],
  }
}

/**
 * Cheap djb2-ish hash to detect content drift without storing the full file
 * text. Collisions are acceptable: at worst we serve a slightly-stale summary
 * until the next refresh interval fires.
 */
const hashContent = (content: string): string => {
  let h = 5381
  for (let i = 0; i < content.length; i += 1) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0
  }
  return `${content.length.toString(36)}:${(h >>> 0).toString(36)}`
}
