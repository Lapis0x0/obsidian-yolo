import { App, normalizePath } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ChatSelectedSkill } from '../../types/chat'
import type { Mentionable } from '../../types/mentionable'
import {
  getMentionableKey,
  serializeMentionable,
} from '../../utils/chat/mentionable'
import { listLiteSkillEntries } from '../skills/liteSkills'

import type { YoloAgentContext } from './agent-api'

type AgentApiTextBlock = Extract<
  YoloAgentContext,
  { type: 'text' | 'markdown' | 'canvas' }
>

export type ResolvedAgentApiContext = {
  textBlocks: AgentApiTextBlock[]
  mentionables: Mentionable[]
  selectedSkills: ChatSelectedSkill[]
}

export async function resolveAgentApiContext({
  app,
  settings,
  context,
}: {
  app: App
  settings: YoloSettings
  context?: YoloAgentContext[]
}): Promise<ResolvedAgentApiContext> {
  const textBlocks: AgentApiTextBlock[] = []
  const mentionables: Mentionable[] = []
  const selectedSkills: ChatSelectedSkill[] = []
  const mentionableKeys = new Set<string>()
  const selectedSkillNames = new Set<string>()
  const skillEntries = context?.some((entry) => entry.type === 'skill')
    ? await listLiteSkillEntries(app, { settings })
    : []

  for (const entry of context ?? []) {
    switch (entry.type) {
      case 'text':
      case 'markdown':
      case 'canvas':
        textBlocks.push(entry)
        break
      case 'file': {
        const path = normalizePath(entry.path)
        const file = app.vault.getFileByPath(path)
        if (!file) {
          throw new Error(`Agent context file not found: ${path}`)
        }
        const mentionable: Mentionable = { type: 'file', file }
        const mentionableKey = getMentionableKey(
          serializeMentionable(mentionable),
        )
        if (!mentionableKeys.has(mentionableKey)) {
          mentionableKeys.add(mentionableKey)
          mentionables.push(mentionable)
        }
        break
      }
      case 'folder': {
        const path = normalizePath(entry.path)
        const folder = app.vault.getFolderByPath(path)
        if (!folder) {
          throw new Error(`Agent context folder not found: ${path}`)
        }
        const mentionable: Mentionable = { type: 'folder', folder }
        const mentionableKey = getMentionableKey(
          serializeMentionable(mentionable),
        )
        if (!mentionableKeys.has(mentionableKey)) {
          mentionableKeys.add(mentionableKey)
          mentionables.push(mentionable)
        }
        break
      }
      case 'skill': {
        const skillName = entry.name.trim()
        const skillEntry = skillEntries.find(
          (candidate) => candidate.name === skillName,
        )
        if (!skillEntry) {
          throw new Error(`Agent context skill not found: ${entry.name}`)
        }
        if (!selectedSkillNames.has(skillEntry.name)) {
          selectedSkillNames.add(skillEntry.name)
          selectedSkills.push({
            name: skillEntry.name,
            description: skillEntry.description,
            path: skillEntry.path,
          })
        }
        break
      }
    }
  }

  return {
    textBlocks,
    mentionables,
    selectedSkills,
  }
}
