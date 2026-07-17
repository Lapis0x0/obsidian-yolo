import type { SerializedEditorState } from 'lexical'

import type { ChatUserMessage } from '../../../types/chat'

type InputMessageUpdater = (message: ChatUserMessage) => ChatUserMessage

export class ChatInputDraftHolder {
  private message: ChatUserMessage
  private replacementVersion = 0

  constructor(initialMessage: ChatUserMessage) {
    this.message = initialMessage
  }

  get(): ChatUserMessage {
    return this.message
  }

  updateContent(content: SerializedEditorState): void {
    this.message = {
      ...this.message,
      content,
    }
  }

  update(updater: InputMessageUpdater): ChatUserMessage {
    this.message = updater(this.message)
    return this.message
  }

  replace(message: ChatUserMessage): ChatUserMessage {
    this.message = message
    this.replacementVersion += 1
    return this.message
  }

  getReplacementVersion(): number {
    return this.replacementVersion
  }
}

export type ChatInputEditorSeed = {
  content: SerializedEditorState | null
  replacementVersion: number
}

export function resolveChatInputEditorSeed(
  currentSeed: ChatInputEditorSeed | null,
  replacementVersion: number,
  getContent: () => SerializedEditorState | null,
): ChatInputEditorSeed {
  if (currentSeed?.replacementVersion === replacementVersion) {
    return currentSeed
  }

  return {
    content: getContent(),
    replacementVersion,
  }
}

export function isChatInputEmpty(
  text: string,
  mentionableCount: number,
  selectedSkillCount: number,
): boolean {
  return (
    text.trim().length === 0 &&
    mentionableCount === 0 &&
    selectedSkillCount === 0
  )
}
