import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const migrateChatModel = (raw: unknown): unknown => {
  if (!isRecord(raw)) return raw
  const m = { ...raw } as Record<string, unknown>

  const reasoning = isRecord(m.reasoning) ? m.reasoning : null
  const thinking = isRecord(m.thinking) ? m.thinking : null

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
  delete m.defaultReasoningLevel
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
      ...next.chatOptions.reasoningLevelByModelId,
    }
    for (const [key, val] of Object.entries(levelMap)) {
      if (val === 'on') {
        levelMap[key] = 'medium'
      }
    }
    next.chatOptions = {
      ...next.chatOptions,
      reasoningLevelByModelId: levelMap,
    }
  }

  return next
}
