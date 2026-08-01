import type { App } from 'obsidian'

import type {
  ChatMessage,
  ChatUserMessage,
  SerializedChatUserMessage,
} from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'
import type { ToolEditSummary } from '../../types/tool-call.types'
import {
  deserializeMentionable,
  serializeMentionable,
} from '../../utils/chat/mentionable'
import { sha256HexPrefix16 } from '../../utils/common/content-hash'

import {
  type CliSessionIndexEntry,
  type CliSessionIndexStore,
  createCliSessionIndexEntry,
} from './session-index'
import { attachCliTurnEditSummary } from './turn-edit-summary'
import type {
  CliSessionHydration,
  CliSessionOverlay,
  CliSessionRef,
  CliTurnConfiguration,
} from './types'

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
    configuration?: CliTurnConfiguration,
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
        ...(configuration
          ? {
              turnConfigurationByTransportHash: {
                ...existing?.turnConfigurationByTransportHash,
                [transportHash]: configuration,
              },
            }
          : {}),
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

  async recordTurnEditSummary(
    ref: CliSessionRef,
    sourceUserMessageId: string,
    summary: ToolEditSummary,
  ): Promise<void> {
    await this.indexStore.update(ref, (existing) =>
      createCliSessionIndexEntry({
        ...ref,
        ...existing,
        turnEditSummaryByUserMessageId: {
          ...existing?.turnEditSummaryByUserMessageId,
          [sourceUserMessageId]: summary,
        },
      }),
    )
  }

  async rebindOverlay(
    previousRef: CliSessionRef,
    nextRef: CliSessionRef,
    dropTurnUserMessageIds: readonly string[] = [],
  ): Promise<void> {
    const droppedIds = new Set(dropTurnUserMessageIds)
    const withoutDroppedSummaries = (
      summaries: CliSessionIndexEntry['turnEditSummaryByUserMessageId'],
    ) =>
      summaries
        ? Object.fromEntries(
            Object.entries(summaries).filter(
              ([userMessageId]) => !droppedIds.has(userMessageId),
            ),
          )
        : undefined
    if (
      previousRef.runtimeId === nextRef.runtimeId &&
      previousRef.nativeSessionId === nextRef.nativeSessionId
    ) {
      if (droppedIds.size > 0) {
        await this.indexStore.update(nextRef, (current) =>
          createCliSessionIndexEntry({
            ...nextRef,
            ...current,
            turnEditSummaryByUserMessageId: withoutDroppedSummaries(
              current?.turnEditSummaryByUserMessageId,
            ),
          }),
        )
      }
      return
    }
    const existing = await this.indexStore.get(previousRef)
    if (!existing) return
    await this.indexStore.update(nextRef, (current) =>
      createCliSessionIndexEntry({
        ...nextRef,
        ...existing,
        ...current,
        runtimeId: nextRef.runtimeId,
        nativeSessionId: nextRef.nativeSessionId,
        turnEditSummaryByUserMessageId: {
          ...withoutDroppedSummaries(existing.turnEditSummaryByUserMessageId),
          ...current?.turnEditSummaryByUserMessageId,
        },
        ...(nextRef.sessionPathHint
          ? { sessionPathHint: nextRef.sessionPathHint }
          : {}),
      }),
    )
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
    const restored = await this.restoreSessionOverlay(ref, messages)
    return [...restored.messages]
  }

  async restoreSessionOverlay(
    ref: CliSessionRef,
    messages: readonly ChatMessage[],
  ): Promise<CliSessionOverlay> {
    const entry = await this.indexStore.get(ref)
    const displays = entry?.userDisplayByTransportHash
    const turnConfigurations = entry?.turnConfigurationByTransportHash
    const turnConfigurationByUserMessageId: Record<
      string,
      CliTurnConfiguration
    > = {}
    const restoredMessages = displays
      ? await Promise.all(
          messages.map(async (message): Promise<ChatMessage> => {
            if (message.role !== 'user' || message.promptContent === null) {
              return message
            }
            const transportHash = await hashTransportContent(
              ref,
              message.promptContent,
            )
            const configuration = turnConfigurations?.[transportHash]
            if (configuration) {
              turnConfigurationByUserMessageId[message.id] = configuration
            }
            const display = displays[transportHash]
            if (!display) return message
            const mentionables = display.mentionables
              .map((mentionable) =>
                deserializeMentionable(mentionable, this.app),
              )
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
      : [...messages]

    const messagesWithSummaries = Object.entries(
      entry?.turnEditSummaryByUserMessageId ?? {},
    ).reduce<readonly ChatMessage[]>(
      (current, [sourceUserMessageId, summary]) =>
        attachCliTurnEditSummary(current, sourceUserMessageId, summary),
      restoredMessages,
    )
    return {
      messages: [...messagesWithSummaries],
      turnConfigurationByUserMessageId,
    }
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
