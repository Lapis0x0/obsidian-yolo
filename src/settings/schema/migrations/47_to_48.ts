import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const migrateChatModel = (raw: unknown): unknown => {
  if (!isRecord(raw)) return raw
  const m = { ...raw } as Record<string, unknown>

  const reasoning = isRecord(m.reasoning) ? m.reasoning : null
  const thinking = isRecord(m.thinking) ? m.thinking : null

  if (reasoning && reasoning.enabled === true) {
    const effort = reasoning.reasoning_effort
    m.defaultReasoningLevel =
      effort === 'low'
        ? 'low'
        : effort === 'high'
          ? 'high'
          : effort === 'medium'
            ? 'medium'
            : 'medium'
  } else if (thinking && thinking.enabled === true) {
    const bRaw = thinking.thinking_budget ?? thinking.budget_tokens
    const b = typeof bRaw === 'number' ? bRaw : null
    if (b === -1) m.defaultReasoningLevel = 'auto'
    else if (b === 0 || b == null) m.defaultReasoningLevel = 'off'
    else if (b <= 4096) m.defaultReasoningLevel = 'low'
    else if (b <= 8192) m.defaultReasoningLevel = 'medium'
    else if (b <= 16384) m.defaultReasoningLevel = 'high'
    else m.defaultReasoningLevel = 'extra-high'
  } else {
    m.defaultReasoningLevel = 'off'
  }

  if (m.reasoningType === 'generic') {
    if (reasoning && reasoning.enabled === true) {
      m.reasoningType = 'openai'
    } else if (typeof thinking?.budget_tokens === 'number') {
      m.reasoningType = 'anthropic'
    } else if (typeof thinking?.thinking_budget === 'number') {
      m.reasoningType = 'gemini'
    } else {
      m.reasoningType = 'openai'
    }
  }

  delete m.reasoning
  delete m.thinking
  return m
}

export const migrateFrom47To48: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 48 }

  if (Array.isArray(next.chatModels)) {
    next.chatModels = next.chatModels.map(migrateChatModel)
  }

  if (
    isRecord(next.chatOptions) &&
    isRecord(next.chatOptions.reasoningLevelByModelId)
  ) {
    const levelMap: Record<string, unknown> = {
      ...(next.chatOptions.reasoningLevelByModelId as Record<string, unknown>),
    }
    for (const [key, val] of Object.entries(levelMap)) {
      if (val === 'on') {
        levelMap[key] = 'medium'
      }
    }
    next.chatOptions = { ...next.chatOptions, reasoningLevelByModelId: levelMap }
  }

  return next
}
