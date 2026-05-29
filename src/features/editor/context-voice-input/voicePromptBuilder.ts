import {
  type ContextVoiceInputOptions,
  DEFAULT_VOICE_INPUT_SYSTEM_PROMPT,
  VOICE_POLISH_PROMPT_PRESETS,
} from '../../../settings/schema/setting.types'
import type { RequestMessage } from '../../../types/llm/request'

export type VoiceInputTarget = {
  fileTitle: string
  filePath: string
  before: string
  after: string
  selectionText: string
  hasSelection: boolean
}

export type BuildVoicePromptInput = {
  options: ContextVoiceInputOptions
  target: VoiceInputTarget
  asrTranscript: string
  previousModelOutput?: string
  /**
   * Optional pre-computed summary of the whole document. Only attached when
   * `documentSummaryEnabled` is on and the summary manager has produced one
   * for this file. Kept short so it doesn't dominate the prompt.
   */
  documentSummary?: string | null
  /**
   * Optional ASR-confusable terms extracted from the document by the same
   * summary call. Surfaced as <asr_hot_words> so the polish model knows
   * which spellings to preserve when the transcript came back with a
   * near-miss. May be empty.
   */
  documentHotWords?: readonly string[] | null
}

/**
 * Cap the after-cursor window at its budget. The before-cursor side is
 * handled UPSTREAM by `VoicePrefixCacheManager` (anchored slicing for
 * prefix-cache hits), so we accept `before` here verbatim — re-slicing
 * it from the tail would undo the anchor and break the cache.
 */
export function splitContextWindow(target: {
  before: string
  after: string
  afterBudget: number
}): { before: string; after: string } {
  const afterBudget = Math.max(0, target.afterBudget)
  const afterSlice = target.after.slice(0, afterBudget)
  return { before: target.before, after: afterSlice }
}

const renderTargetBlock = (target: VoiceInputTarget): string => {
  const meta = [
    target.fileTitle ? `file_title: ${target.fileTitle}` : null,
    target.filePath ? `file_path: ${target.filePath}` : null,
    `has_selection: ${target.hasSelection ? 'true' : 'false'}`,
  ]
    .filter(Boolean)
    .join('\n')
  return `<target_metadata>${meta}</target_metadata>`
}

export function buildVoiceInputMessages(
  input: BuildVoicePromptInput,
): RequestMessage[] {
  const {
    options,
    target,
    asrTranscript,
    previousModelOutput,
    documentSummary,
    documentHotWords,
  } = input
  // Built-in preset → use the canned prompt. Custom → use the user textarea
  // when non-empty, otherwise fall back to the default preset.
  const systemPromptBody = (() => {
    const mode = options.systemPromptMode
    if (mode === 'custom') {
      return options.customSystemPrompt.trim().length > 0
        ? options.customSystemPrompt
        : DEFAULT_VOICE_INPUT_SYSTEM_PROMPT
    }
    return (
      VOICE_POLISH_PROMPT_PRESETS[mode] ?? DEFAULT_VOICE_INPUT_SYSTEM_PROMPT
    )
  })()

  const { before, after } = splitContextWindow({
    before: target.before,
    after: target.after,
    afterBudget: options.maxAfterContextChars,
  })

  // Section ordering is deliberate: stable / rarely-changing blocks first,
  // then per-session blocks, then per-segment blocks. Provider prefix caches
  // (Anthropic explicit `cache_control`, OpenAI / DeepSeek automatic) reuse
  // the leading bytes across polish calls in the same session, so don't
  // reorder lightly: any change to a leading block invalidates the cache for
  // the rest.
  //
  // Section layout:
  //   1. target_metadata   — changes only when the file changes
  //   2. document_summary  — refresh interval (default 1h)
  //   3. asr_hot_words     — same refresh as document_summary
  //   4. cursor_before     — changes every segment but stable head
  //   5. cursor_after      — changes every segment
  //   6. current_selection — stable within a session
  //   7. previous_model_output — changes every segment
  //   8. current_asr_final — always the per-segment tail
  const sections: string[] = [renderTargetBlock(target)]
  if (documentSummary && documentSummary.trim().length > 0) {
    sections.push(
      `<document_summary>${documentSummary.trim()}</document_summary>`,
    )
  }
  if (documentHotWords && documentHotWords.length > 0) {
    // Pipe-separated list keeps the block compact and unambiguous (no JSON
    // quoting noise). The system prompt already tells the model how to use
    // these — no per-prompt instruction needed.
    sections.push(
      `<asr_hot_words>${documentHotWords.join(' | ')}</asr_hot_words>`,
    )
  }
  // Every tag wraps its payload tight — no padding newline between the
  // opening tag and the payload, nor between the payload and the closing
  // tag. For raw-content tags (cursor_*, current_selection, *_model_output,
  // current_asr_final) this avoids the polish model misreading wrapper "\n"s
  // as positional signal (e.g. "selection ended at end-of-paragraph" or
  // "cursor sits on a fresh line"). For structured tags (target_metadata,
  // document_summary, asr_hot_words) the wrapper newlines were purely
  // cosmetic — stripping them saves a handful of tokens per call without
  // changing parseability.
  if (before.length > 0) {
    sections.push(`<cursor_before>${before}</cursor_before>`)
  }
  // Skip the cursor_after block when it would only contain whitespace
  // (most commonly a single trailing newline). Including a near-empty
  // <cursor_after></cursor_after> tends to signal "you're at end of a
  // paragraph" to the polish model and triggers the "empty text" branch
  // of the system prompt, which leaves the stage-1 ASR ghost stuck on
  // screen because the controller never receives a usable polish text.
  if (after.trim().length > 0) {
    sections.push(`<cursor_after>${after}</cursor_after>`)
  }
  if (target.hasSelection && target.selectionText.length > 0) {
    sections.push(
      `<current_selection>${target.selectionText}</current_selection>`,
    )
  }
  if (previousModelOutput && previousModelOutput.trim().length > 0) {
    sections.push(
      `<previous_model_output>${previousModelOutput}</previous_model_output>`,
    )
  }
  sections.push(`<current_asr_final>${asrTranscript}</current_asr_final>`)

  // Single newline between sections (was '\n\n'). The closing tag of each
  // section is already an unambiguous boundary; the blank line was visual
  // formatting that the model paid tokens for without benefit.
  const userContent = sections.join('\n')

  return [
    { role: 'system', content: systemPromptBody },
    { role: 'user', content: userContent },
  ]
}
