export const REASONING_LEVELS = [
  'off',
  'auto',
  'low',
  'medium',
  'high',
  'extra-high',
] as const

export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

export const REASONING_META: Record<
  ReasoningLevel,
  { effort: string; budget: number }
> = {
  off: { effort: 'none', budget: 0 },
  auto: { effort: 'auto', budget: -1 },
  low: { effort: 'low', budget: 4096 },
  medium: { effort: 'medium', budget: 8192 },
  high: { effort: 'high', budget: 16384 },
  'extra-high': { effort: 'xhigh', budget: 32768 },
}

export const isReasoningEnabledLevel = (level: ReasoningLevel): boolean =>
  level !== 'off'

export function isReasoningLevelString(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value)
}

/** Per-chat / persisted value may be legacy `'on'` (Claude UI). */
export function normalizeStoredReasoningLevel(
  value: string | undefined | null,
): ReasoningLevel | null {
  if (!value) return null
  if (value === 'on') return 'medium'
  return isReasoningLevelString(value) ? value : null
}

export type ReasoningModelType =
  | 'none'
  | 'openai'
  | 'gemini'
  | 'anthropic'
  | undefined

export function modelSupportsReasoning(model: {
  reasoningType?: ReasoningModelType
}): boolean {
  return Boolean(model.reasoningType && model.reasoningType !== 'none')
}

/**
 * Effective level for the HTTP request: only when `reasoningType` is set and not `none`.
 * Chat override wins; otherwise fall back to `auto` so the model decides.
 */
export function resolveRequestReasoningLevel(
  model: {
    reasoningType?: ReasoningModelType
  },
  override?: ReasoningLevel,
): ReasoningLevel | undefined {
  if (!modelSupportsReasoning(model)) return undefined
  return override ?? 'auto'
}

/** Settings / UI default when the model supports reasoning. */
export function getDefaultReasoningLevel(
  model: {
    reasoningType?: ReasoningModelType
  } | null,
): ReasoningLevel {
  if (!model || !modelSupportsReasoning(model)) return 'off'
  return 'auto'
}
