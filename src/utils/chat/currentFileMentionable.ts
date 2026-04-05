import type { TFile } from 'obsidian'

import type {
  Mentionable,
  MentionableCurrentFile,
} from '../../types/mentionable'
import { getMentionableKey, serializeMentionable } from './mentionable'

export function getDisplayOnlyCurrentFileMentionables(
  mentionables: Mentionable[],
  displayMentionables?: Mentionable[],
): MentionableCurrentFile[] {
  const editableMentionableKeys = new Set(
    mentionables.map((mentionable) =>
      getMentionableKey(serializeMentionable(mentionable)),
    ),
  )

  return (displayMentionables ?? []).filter(
    (mentionable): mentionable is MentionableCurrentFile =>
      mentionable.type === 'current-file' &&
      !editableMentionableKeys.has(
        getMentionableKey(serializeMentionable(mentionable)),
      ),
  )
}

export function normalizeMentionablesWithAutoCurrentFile(
  mentionables: Mentionable[],
  activeFile: TFile | null,
  shouldAttachCurrentFile: boolean,
): Mentionable[] {
  const normalizedMentionables = mentionables.filter(
    (mentionable) => mentionable.type !== 'current-file',
  )

  if (!shouldAttachCurrentFile || !activeFile) {
    return normalizedMentionables
  }

  return [
    {
      type: 'current-file',
      file: activeFile,
    },
    ...normalizedMentionables,
  ]
}

export function getLatestValidCurrentFileMentionable(
  mentionables: Mentionable[],
): TFile | null {
  for (let index = mentionables.length - 1; index >= 0; index -= 1) {
    const mentionable = mentionables[index]
    if (mentionable.type === 'current-file' && mentionable.file) {
      return mentionable.file
    }
  }

  return null
}
