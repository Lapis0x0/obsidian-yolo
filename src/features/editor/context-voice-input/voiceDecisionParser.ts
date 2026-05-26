/**
 * Parser for the structured JSON output the polish LLM returns for the
 * context-aware voice input feature.
 *
 * The system prompt asks the model to emit:
 *
 *   { "action": "insert_at_cursor" | "insert_after_selection" |
 *               "replace_selection" | "cancel_input",
 *     "text": string }
 *
 * Real-world models will sometimes wrap that in a ```json fence, sometimes
 * leak a trailing comment, sometimes drop the structure entirely. This
 * parser tries to recover from common deviations and falls back to a plain
 * `insert_at_cursor` decision when the body looks like plain text rather
 * than JSON, so a misconfigured model still produces *something* the user
 * can accept or reject.
 */

export type VoiceEditorAction =
  | 'insert_at_cursor'
  | 'insert_after_selection'
  | 'replace_selection'
  | 'cancel_input'

export type VoiceEditorDecision = {
  action: VoiceEditorAction
  text: string
}

const ACTIONS: readonly VoiceEditorAction[] = [
  'insert_at_cursor',
  'insert_after_selection',
  'replace_selection',
  'cancel_input',
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

export function parseVoiceEditorDecision(
  rawContent: string,
  context: { hasSelection: boolean },
): VoiceEditorDecision {
  const stripped = stripFences(rawContent)
  const jsonSlice = extractFirstJsonObject(stripped) ?? stripped

  try {
    const parsed: unknown = JSON.parse(jsonSlice)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as { action?: unknown; text?: unknown }
      const action = isAction(obj.action) ? obj.action : null
      const text = typeof obj.text === 'string' ? obj.text : ''
      if (action) {
        if (action === 'cancel_input') {
          return { action, text: '' }
        }
        if (
          (action === 'replace_selection' ||
            action === 'insert_after_selection') &&
          !context.hasSelection
        ) {
          // The model decided to act on a selection that no longer exists
          // (or never existed). Demote to a plain cursor insert so we don't
          // silently swallow the user's transcript.
          return { action: 'insert_at_cursor', text }
        }
        return { action, text }
      }
    }
  } catch {
    // Fall through to the plain-text fallback below.
  }

  const fallbackText = stripped.trim()
  return { action: 'insert_at_cursor', text: fallbackText }
}
