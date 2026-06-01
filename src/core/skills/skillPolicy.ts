import { Assistant, AssistantSkillLoadMode } from '../../types/assistant.types'

export type ResolvedAssistantSkillPolicy = {
  enabled: boolean
  loadMode: AssistantSkillLoadMode
}

/**
 * @param disabledSkillNames Globally disabled skill names (canonical skill
 *   names, trim-only, case-sensitive). The persisted field is still called
 *   `disabledSkillIds` for backwards compatibility — its elements are skill
 *   names.
 */
export function getDisabledSkillNameSet(
  disabledSkillNames?: string[],
): Set<string> {
  return new Set((disabledSkillNames ?? []).map((name) => name.trim()))
}

export function resolveAssistantSkillPolicy({
  assistant,
  skillName,
  defaultLoadMode,
}: {
  assistant: Assistant | null | undefined
  skillName: string
  defaultLoadMode?: AssistantSkillLoadMode
}): ResolvedAssistantSkillPolicy {
  const preference = assistant?.skillPreferences?.[skillName]
  const enabled = preference?.enabled ?? true
  const loadMode: AssistantSkillLoadMode =
    preference?.loadMode === 'always'
      ? 'always'
      : preference?.loadMode === 'lazy'
        ? 'lazy'
        : (defaultLoadMode ?? 'lazy')

  return {
    enabled,
    loadMode,
  }
}

export function isSkillEnabledForAssistant({
  assistant,
  skillName,
  disabledSkillNames,
  defaultLoadMode,
}: {
  assistant: Assistant | null | undefined
  skillName: string
  disabledSkillNames?: string[]
  defaultLoadMode?: AssistantSkillLoadMode
}): boolean {
  const disabledSet = getDisabledSkillNameSet(disabledSkillNames)
  if (disabledSet.has(skillName)) {
    return false
  }

  return resolveAssistantSkillPolicy({
    assistant,
    skillName,
    defaultLoadMode,
  }).enabled
}
