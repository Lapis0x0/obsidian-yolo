import type { Mentionable, MentionableBlock } from '../../../types/mentionable'

export type QuickAskVisibleMode = 'chat' | 'agent'
export type QuickAskLaunchMode =
  | QuickAskVisibleMode
  | 'ask'
  | 'edit'
  | 'edit-direct'

export type QuickAskSelectionScope = {
  mentionable: MentionableBlock
  selectionFrom: { line: number; ch: number }
}

export type QuickAskShowOptions = {
  initialPrompt?: string
  initialMentionables?: Mentionable[]
  initialMode?: QuickAskLaunchMode
  initialInput?: string
  editContextText?: string
  editSelectionFrom?: { line: number; ch: number }
  selectionScope?: QuickAskSelectionScope
  autoSend?: boolean
}
