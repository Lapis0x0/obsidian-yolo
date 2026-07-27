import type {
  VoiceEditorAction,
  VoiceEditorDecision,
} from './voiceDecisionParser'

const ADJACENT_BOUNDARY_CHARS = new Set(Array.from('。.!?,，！？;；:：、'))

export type VoiceBoundaryFallbackContext = {
  before: string
  after: string
  asrTranscript: string
}

/**
 * Deterministic splice cleanup after the polish model returns JSON.
 *
 * Boundary punctuation was the least reliable part of the prompt-only
 * approach: models would sometimes preserve ASR's final "."/"。" before an
 * already-existing cursor_after punctuation mark, or emit the same leading
 * boundary punctuation twice. Those fixes depend only on the real insertion
 * boundary, not on language understanding, so keeping them in code lets the
 * default prompt stay short and keeps preview/accept behavior identical.
 */
export function applyVoiceDecisionBoundaryFallback(
  decision: VoiceEditorDecision,
  context: VoiceBoundaryFallbackContext,
): VoiceEditorDecision {
  if (decision.malformed || decision.text.length === 0) return decision

  let text = decision.text
  if (/\s$/.test(context.before)) {
    text = text.replace(/^\s+/, '')
  }

  const firstAfter = Array.from(context.after)[0] ?? ''
  if (ADJACENT_BOUNDARY_CHARS.has(firstAfter)) {
    while (
      text.length > 0 &&
      ADJACENT_BOUNDARY_CHARS.has(Array.from(text).at(-1) ?? '')
    ) {
      const last = Array.from(text).at(-1) ?? ''
      text = text.slice(0, -last.length)
    }

    const asrStartsWithAfter = context.asrTranscript
      .trimStart()
      .startsWith(firstAfter)
    const duplicatedLeadingBoundary = text.startsWith(firstAfter + firstAfter)
    if (!asrStartsWithAfter && duplicatedLeadingBoundary) {
      text = text.slice(firstAfter.length).replace(/^\s+/, '')
    }
  }

  return text === decision.text ? decision : { ...decision, text }
}

export function getVoiceDecisionInsertionOffset(
  action: VoiceEditorAction,
  target: {
    startCursorOffset: number
    selectionFromOffset: number
    selectionToOffset: number
  },
): number {
  if (action === 'insert_after_selection') return target.selectionToOffset
  if (action === 'replace_selection') return target.selectionFromOffset
  return target.startCursorOffset
}
