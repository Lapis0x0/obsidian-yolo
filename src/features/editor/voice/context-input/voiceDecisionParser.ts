/**
 * Parser for the structured JSON output the polish LLM returns for the
 * context-aware voice input feature.
 *
 * The system prompt asks the model to emit:
 *
 *   { "action": "insert_at_cursor" | "insert_after_selection" |
 *               "replace_selection",
 *     "text": string,
 *     "notice"?: string }
 *
 * `notice` is shown to the user as a small toast (prefixed so they know
 * it came from the polish model). It is NOT inserted into the editor.
 * Two main use cases:
 *   - cancel directives (transcript was "never mind") → text="" + notice
 *   - transform directives ("change the last word to X") → polished text in
 *     `text`, notice explains what was done so the user isn't confused that
 *     the directive itself disappeared.
 *
 * Real-world models will sometimes wrap that in a ```json fence, sometimes
 * leak a trailing comment, sometimes drop the structure entirely. This
 * parser tries to recover from common deviations. When the fallback would
 * dump raw JSON-looking text into the editor (the model emitted broken
 * JSON), we instead return empty text with a flag so the controller can
 * show a "malformed output" notice.
 */

export type VoiceEditorAction =
  | 'insert_at_cursor'
  | 'insert_after_selection'
  | 'replace_selection'

export type VoiceEditorDecision = {
  action: VoiceEditorAction
  text: string
  notice?: string
  /**
   * Set when the parser refused to insert raw text because the model output
   * looked like a malformed JSON envelope. The controller surfaces a
   * dedicated notice in this case rather than inserting garbage.
   */
  malformed?: boolean
}

const ACTIONS: readonly VoiceEditorAction[] = [
  'insert_at_cursor',
  'insert_after_selection',
  'replace_selection',
]

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

const extractFirstJsonObject = (raw: string): string | null => {
  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        return raw.slice(start, i + 1)
      }
    }
  }
  return null
}

const isAction = (value: unknown): value is VoiceEditorAction =>
  typeof value === 'string' && (ACTIONS as readonly string[]).includes(value)

/**
 * Heuristic: does this text look like a JSON envelope of our schema rather
 * than user-facing prose? Used to refuse the plain-text fallback when the
 * model emitted broken JSON, so we don't insert `{ "action": "..." ...`
 * literally into the user's document.
 */
const looksLikeJsonPayload = (text: string): boolean => {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return false
  return /"action"\s*:/.test(trimmed) || /"text"\s*:/.test(trimmed)
}

export function parseVoiceEditorDecision(
  rawContent: string,
  context: { hasSelection: boolean },
): VoiceEditorDecision {
  const stripped = stripFences(rawContent)
  const jsonSlice = extractFirstJsonObject(stripped) ?? stripped

  try {
    const parsed: unknown = JSON.parse(jsonSlice)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as {
        action?: unknown
        text?: unknown
        notice?: unknown
      }
      const notice =
        typeof obj.notice === 'string' && obj.notice.trim().length > 0
          ? obj.notice.trim()
          : undefined
      const action = isAction(obj.action) ? obj.action : null
      const text = typeof obj.text === 'string' ? obj.text : ''
      if (action) {
        if (
          (action === 'replace_selection' ||
            action === 'insert_after_selection') &&
          !context.hasSelection
        ) {
          // Model picked a selection-relative action but the selection is
          // gone (or never existed). Demote to a plain cursor insert so we
          // don't silently swallow the user's transcript.
          return { action: 'insert_at_cursor', text, notice }
        }
        return { action, text, notice }
      }
    }
  } catch {
    // Fall through to the plain-text fallback below.
  }

  const fallbackText = stripped.trim()
  if (fallbackText.length === 0) {
    return { action: 'insert_at_cursor', text: '' }
  }
  if (looksLikeJsonPayload(fallbackText)) {
    // The model tried to emit our JSON envelope but produced something we
    // couldn't parse. Refuse to insert the raw blob — let the controller
    // surface a "malformed output" notice instead.
    return { action: 'insert_at_cursor', text: '', malformed: true }
  }
  return { action: 'insert_at_cursor', text: fallbackText }
}
