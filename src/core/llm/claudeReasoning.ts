import { REASONING_META, type ReasoningLevel } from '../../types/reasoning'

// How a Claude model takes reasoning, decided from its id alone. Claude
// models up to 4.5 take a fixed `budget_tokens`; every later one takes
// adaptive thinking plus `effort` (4.7 and later reject `budget_tokens`).
// The budget generation is a closed set — no new model joins it — so a
// Claude id this cannot place is a newer model and gets the adaptive shape.

type ClaudeVersion = { major: number; minor: number }

// Matches every provider's spelling: `claude-opus-4-8`, `claude-3-5-sonnet-…`,
// `anthropic.claude-sonnet-4-5-20250929-v1:0`, `anthropic/claude-sonnet-4.5`.
// The minor must be one or two digits not followed by another digit, so a
// date suffix (`claude-sonnet-4-20250514`) is not read as a minor version.
const CLAUDE_VERSION_PATTERN =
  /claude-(?:(?:opus|sonnet|haiku|fable|mythos)-)?(\d{1,2})(?:[-.](\d{1,2})(?!\d))?/

const parseClaudeVersion = (modelId: string): ClaudeVersion | null => {
  const match = CLAUDE_VERSION_PATTERN.exec(modelId.toLowerCase())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2] ?? 0) }
}

export const isClaudeModelId = (modelId: string): boolean =>
  modelId.toLowerCase().includes('claude')

const isBudgetGeneration = (version: ClaudeVersion | null): boolean =>
  version !== null &&
  (version.major < 4 || (version.major === 4 && version.minor <= 5))

export type ClaudeReasoningRequest = {
  /** The `thinking` request field; undefined leaves it out. */
  thinking?:
    | { type: 'enabled'; budget_tokens: number }
    | { type: 'adaptive'; display: 'summarized' }
  /** `output_config.effort`; undefined leaves it out. */
  effort?: string
  /** Tokens `max_tokens` must leave for thinking on top of the reply. */
  thinkingTokens: number
}

/**
 * The reasoning fields for a Claude model at `level`, or null when `modelId`
 * is not a Claude model (an Anthropic-compatible endpoint serving another
 * vendor's model), whose request shape the caller keeps as it was.
 *
 * On the adaptive generation `off` means the lowest effort, not disabled
 * thinking: Opus 5.5 and Fable reject disabled thinking outright, and on
 * Opus 5 it makes the model write tool calls into its visible text.
 */
export function resolveClaudeReasoningRequest(
  modelId: string,
  level: ReasoningLevel,
): ClaudeReasoningRequest | null {
  if (!isClaudeModelId(modelId)) return null
  const version = parseClaudeVersion(modelId)

  if (isBudgetGeneration(version)) {
    if (level === 'off') return { thinkingTokens: 0 }
    const budget = REASONING_META[level === 'auto' ? 'medium' : level].budget
    return {
      thinking: { type: 'enabled', budget_tokens: budget },
      thinkingTokens: budget,
    }
  }

  const thinking = { type: 'adaptive', display: 'summarized' } as const
  if (level === 'auto') {
    return { thinking, thinkingTokens: REASONING_META.high.budget }
  }
  const effortLevel = level === 'off' ? 'low' : level
  // `xhigh` arrived with 4.7; 4.6 takes up to `high` below `max`.
  const supportedLevel =
    effortLevel === 'xhigh' && version?.major === 4 && version.minor === 6
      ? 'high'
      : effortLevel
  return {
    thinking,
    effort: REASONING_META[supportedLevel].effort,
    thinkingTokens: REASONING_META[supportedLevel].budget,
  }
}

/**
 * False on the adaptive generation. 4.7 and later reject `temperature` and
 * `top_p` with a 400; 4.6 still takes them but is treated the same way, so a
 * sampling setting behaves identically on every current Claude model.
 */
export function claudeAcceptsSamplingParams(modelId: string): boolean {
  if (!isClaudeModelId(modelId)) return true
  return isBudgetGeneration(parseClaudeVersion(modelId))
}

const CLAUDE_FAMILY_VERSION_PATTERN =
  /claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:[-.](\d{1,2})(?!\d))?/

/**
 * Whether the model binds each thinking block's signature to everything sent
 * before it (Opus 5.5, Fable 5.1, Mythos 5.1 and later): a request that
 * changes that prefix must tell the API what to do with the stale blocks. A
 * Claude id this cannot place is a newer model and is treated as binding.
 */
export function claudeBindsThinkingToPrefix(modelId: string): boolean {
  if (!isClaudeModelId(modelId)) return false
  const match = CLAUDE_FAMILY_VERSION_PATTERN.exec(modelId.toLowerCase())
  if (!match) return parseClaudeVersion(modelId) === null
  const version = Number(match[2]) + Number(match[3] ?? 0) / 10
  switch (match[1]) {
    case 'opus':
      return version >= 5.5
    case 'fable':
    case 'mythos':
      return version >= 5.1
    default:
      return false
  }
}
