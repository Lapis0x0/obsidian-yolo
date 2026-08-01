import type { App } from 'obsidian'

import type {
  ChatMessage,
  ChatUserMessage,
  SerializedChatUserMessage,
} from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'
import {
  deserializeMentionable,
  serializeMentionable,
} from '../../utils/chat/mentionable'
import { sha256HexPrefix16 } from '../../utils/common/content-hash'

import {
  type CliSessionIndexStore,
  createCliSessionIndexEntry,
} from './session-index'
import type { CliSessionHydration, CliSessionRef } from './types'

export class CliSessionService {
  constructor({
    app,
    indexStore,
  }: {
    app: App
    indexStore: CliSessionIndexStore
  }) {
    this.app = app
    this.indexStore = indexStore
  }

  private readonly indexStore: CliSessionIndexStore
  private readonly app: App

  async recordOpenedSession(hydration: CliSessionHydration): Promise<void> {
    const ref = hydration.ref
    await this.indexStore.update(ref, (existing) =>
      createCliSessionIndexEntry({
        ...ref,
        ...existing,
        ...(hydration.ref.sessionPathHint
          ? { sessionPathHint: hydration.ref.sessionPathHint }
          : existing?.sessionPathHint
            ? { sessionPathHint: existing.sessionPathHint }
            : {}),
      }),
    )
  }

  async recordUserDisplay(
    ref: CliSessionRef,
    transportContent: string | ContentPart[],
    message: ChatUserMessage,
  ): Promise<void> {
    const transportHash = await hashTransportContent(ref, transportContent)
    const serialized: SerializedChatUserMessage = {
      ...message,
      promptContent: null,
      mentionables: message.mentionables.map(serializeMentionable),
    }
    await this.indexStore.update(ref, (existing) =>
      createCliSessionIndexEntry({
        ...ref,
        ...existing,
        userDisplayByTransportHash: {
          ...existing?.userDisplayByTransportHash,
          [transportHash]: serialized,
        },
      }),
    )
  }

  async getRememberedConfiguration(ref: CliSessionRef): Promise<{
    modelId?: string | null
    reasoningEffort?: string | null
  }> {
    const entry = await this.indexStore.get(ref)
    return {
      ...(entry && 'modelId' in entry ? { modelId: entry.modelId } : {}),
      ...(entry && 'reasoningEffort' in entry
        ? { reasoningEffort: entry.reasoningEffort }
        : {}),
    }
  }

  async rememberConfiguration(
    ref: CliSessionRef,
    configuration: { modelId?: string | null; reasoningEffort?: string | null },
  ): Promise<void> {
    await this.indexStore.update(ref, (existing) =>
      createCliSessionIndexEntry({
        ...ref,
        ...existing,
        ...configuration,
      }),
    )
  }

  async restoreUserDisplays(
    ref: CliSessionRef,
    messages: readonly ChatMessage[],
  ): Promise<ChatMessage[]> {
    const displays = (await this.indexStore.get(ref))
      ?.userDisplayByTransportHash
    if (!displays) return [...messages]

    return await Promise.all(
      messages.map(async (message): Promise<ChatMessage> => {
        if (message.role !== 'user' || message.promptContent === null) {
          return message
        }
        const display =
          displays[await hashTransportContent(ref, message.promptContent)]
        if (!display) return message
        const mentionables = display.mentionables
          .map((mentionable) => deserializeMentionable(mentionable, this.app))
          .filter(
            (
              mentionable,
            ): mentionable is ChatUserMessage['mentionables'][number] =>
              mentionable !== null,
          )
        return {
          ...display,
          id: message.id,
          promptContent: display.promptContent,
          mentionables,
        }
      }),
    )
  }

  removeOverlay(ref: CliSessionRef): Promise<boolean> {
    return this.indexStore.remove(ref)
  }
}

const hashTransportContent = (
  ref: CliSessionRef,
  content: string | ContentPart[],
): Promise<string> =>
  sha256HexPrefix16(normalizeHydratedUserContent(ref, content))

const normalizeHydratedUserContent = (
  ref: CliSessionRef,
  content: string | ContentPart[],
): string => {
  if (typeof content === 'string') return content
  if (ref.runtimeId === 'claude-code') {
    return content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('')
  }
  return content
    .map((part) => {
      if (part.type === 'text') return part.text
      if (part.type === 'image_url') return `[Image: ${part.image_url.url}]`
      return `[Document: ${part.name}]`
    })
    .join('\n\n')
}
