import type { Mentionable, MentionableBlock } from '../../../types/mentionable'

export const QUICK_ASK_CURSOR_MARKER = '<<CURSOR>>'

export type QuickAskVisibleMode = 'ask' | 'agent' | 'continue'
export type QuickAskLaunchMode = QuickAskVisibleMode

export type QuickAskSelectionScope = {
  mentionable: MentionableBlock
  selectionFrom: { line: number; ch: number }
}

export type QuickAskShowOptions = {
  initialPrompt?: string
  initialMentionables?: Mentionable[]
  initialMode?: QuickAskLaunchMode
  initialInput?: string
  selectionScope?: QuickAskSelectionScope
  /**
   * One-shot rewrite entry: the panel opens as a "改写" (rewrite) prompt
   * scoped to `selectionScope`. Submitting hands off to
   * `plugin.startSelectionRewrite` instead of the normal ask/agent runtime.
   * Never persisted to settings — switching Ask/Agent from the dropdown
   * exits this intent for the rest of the session.
   */
  isRewriteEntry?: boolean
  autoSend?: boolean
  initialAssistantId?: string
}
