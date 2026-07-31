import type { App } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import { type LiteSkillEntry, listLiteSkillEntries } from '../skills/liteSkills'
import { isSkillEnabledForAssistant } from '../skills/skillPolicy'

import type { CliAssistantBinding } from './types'

type ListSkillEntries = (
  app: App,
  options: { settings: YoloSettings },
) => Promise<LiteSkillEntry[]>

export type ResolveCliAssistantBindingInput = {
  app: App
  settings: YoloSettings
  assistantId: string
  listSkillEntries?: ListSkillEntries
}

export const getCliAssistantBindingCacheKey = (
  settings: YoloSettings,
  assistantId: string,
): string =>
  JSON.stringify({
    assistant: settings.assistants.find(
      (candidate) => candidate.id === assistantId,
    ),
    skills: settings.skills,
    yolo: settings.yolo,
  })

/** Resolve the exact session-level persona and skill set used by CLI agents. */
export const resolveCliAssistantBinding = async ({
  app,
  settings,
  assistantId,
  listSkillEntries = listLiteSkillEntries,
}: ResolveCliAssistantBindingInput): Promise<CliAssistantBinding> => {
  const assistant = settings.assistants.find(
    (candidate) => candidate.id === assistantId,
  )
  if (!assistant) {
    throw new Error(`Assistant is unavailable: ${assistantId}`)
  }

  const disabledSkillNames = settings.skills?.disabledSkillIds ?? []
  const enabledSkillNames = (await listSkillEntries(app, { settings }))
    .filter((skill) =>
      isSkillEnabledForAssistant({
        assistant,
        skillName: skill.name,
        disabledSkillNames,
        defaultLoadMode: skill.mode,
      }),
    )
    .map((skill) => skill.name)
    .sort((left, right) => left.localeCompare(right))

  return {
    assistantId: assistant.id,
    systemPrompt: assistant.systemPrompt,
    enabledSkillNames,
  }
}
