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

import { parseCodexUserMessageId } from './codex/mapping'
import {
  type CliSessionIndexEntry,
  type CliSessionIndexStore,
  createCliSessionIndexEntry,
} from './session-index'
import { attachCliTurnEditSummary } from './turn-edit-summary'
import { stripCliEnvironmentContext } from './turn-input'
import type {
  CliContextUsage,
  CliSessionHydration,
  CliSessionOverlay,
  CliSessionRef,
  CliTurnConfiguration,
} from './types'

type CliTurnOverlay = NonNullable<CliSessionIndexEntry['turnOverlays']>[number]

const getOverlayClientUserMessageId = (
  ref: CliSessionRef,
  messageId: string,
): string => {
  if (ref.runtimeId === 'claude-code') return messageId
  const locator = parseCodexUserMessageId(messageId)
  return locator.kind === 'client' ? locator.id : messageId
}

const getHydratedClientUserMessageId = (
  ref: CliSessionRef,
  messageId: string,
): string | null => {
  if (ref.runtimeId === 'claude-code') return messageId
  const locator = parseCodexUserMessageId(messageId)
  return locator.kind === 'client' ? locator.id : null
}

const getStoredOverlayClientUserMessageId = (
  ref: CliSessionRef,
  overlay: CliTurnOverlay,
): string | null => {
  if (overlay.clientUserMessageId) return overlay.clientUserMessageId
  if (ref.runtimeId === 'claude-code') return overlay.userMessage.id
  const messageId = overlay.userMessage.id
  if (!messageId.startsWith('codex-user-')) return messageId
  const locator = parseCodexUserMessageId(messageId)
  return locator.kind === 'client' ? locator.id : null
}

const stripHydratedCliEnvironmentContext = (
  message: ChatUserMessage,
): ChatUserMessage =>
  message.promptContent !== null
    ? {
        ...message,
        promptContent: stripCliEnvironmentContext(message.promptContent),
      }
    : message

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
        ...(hydration.ref.profileId
          ? { profileId: hydration.ref.profileId }
          : existing?.profileId
            ? { profileId: existing.profileId }
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
        turnOverlays: [
          ...(existing?.turnOverlays ?? []),
          {
            clientUserMessageId: getOverlayClientUserMessageId(ref, message.id),
            transportHash,
            userMessage: serialized,
            ...(configuration ? { configuration } : {}),
          },
        ],
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
    const withoutDroppedTurnOverlays = (
      overlays: CliSessionIndexEntry['turnOverlays'],
    ) => overlays?.filter((overlay) => !droppedIds.has(overlay.userMessage.id))
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
            turnOverlays: withoutDroppedTurnOverlays(current?.turnOverlays),
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
        turnOverlays: mergeTurnOverlays(
          withoutDroppedTurnOverlays(existing.turnOverlays),
          current?.turnOverlays,
        ),
        ...(nextRef.sessionPathHint
          ? { sessionPathHint: nextRef.sessionPathHint }
          : {}),
        ...(nextRef.profileId ? { profileId: nextRef.profileId } : {}),
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

  async rememberContextUsage(
    ref: CliSessionRef,
    usage: CliContextUsage,
  ): Promise<void> {
    if (usage.cacheHitRate === undefined) return
    await this.indexStore.update(ref, (existing) =>
      createCliSessionIndexEntry({
        ...ref,
        ...existing,
        lastCacheHitRate: usage.cacheHitRate,
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
    const turnOverlays = entry?.turnOverlays ?? []
    const reconciledTurnOverlays = [...turnOverlays]
    const consumedOverlayIndexes = new Set<number>()
    let didReconcileOverlayIds = false
    const turnConfigurationByUserMessageId: Record<
      string,
      CliTurnConfiguration
    > = {}
    const restoredMessages: ChatMessage[] = []
    for (const message of messages) {
      if (message.role !== 'user' || message.promptContent === null) {
        restoredMessages.push(message)
        continue
      }
      const hydratedClientUserMessageId = getHydratedClientUserMessageId(
        ref,
        message.id,
      )
      let overlayIndex = turnOverlays.findIndex(
        (overlay, index) =>
          !consumedOverlayIndexes.has(index) &&
          hydratedClientUserMessageId !== null &&
          getStoredOverlayClientUserMessageId(ref, overlay) ===
            hydratedClientUserMessageId,
      )
      if (overlayIndex < 0) {
        const transportHash = await hashTransportContent(
          ref,
          message.promptContent,
        )
        overlayIndex = turnOverlays.findIndex(
          (overlay, index) =>
            !consumedOverlayIndexes.has(index) &&
            overlay.transportHash === transportHash,
        )
      }
      if (overlayIndex < 0) {
        restoredMessages.push(stripHydratedCliEnvironmentContext(message))
        continue
      }
      consumedOverlayIndexes.add(overlayIndex)
      const overlay = turnOverlays[overlayIndex]
      if (overlay.configuration) {
        turnConfigurationByUserMessageId[message.id] = overlay.configuration
      }
      const display = overlay.userMessage
      const mentionables = display.mentionables
        .map((mentionable) => deserializeMentionable(mentionable, this.app))
        .filter(
          (
            mentionable,
          ): mentionable is ChatUserMessage['mentionables'][number] =>
            mentionable !== null,
        )
      restoredMessages.push({
        ...display,
        id: message.id,
        promptContent: display.promptContent,
        mentionables,
      })
      if (display.id !== message.id) {
        reconciledTurnOverlays[overlayIndex] = {
          ...overlay,
          userMessage: { ...display, id: message.id },
        }
        didReconcileOverlayIds = true
      }
    }

    if (didReconcileOverlayIds) {
      await this.indexStore.update(ref, (current) =>
        createCliSessionIndexEntry({
          ...ref,
          ...current,
          turnOverlays: (current?.turnOverlays ?? []).map(
            (overlay, index) => reconciledTurnOverlays[index] ?? overlay,
          ),
        }),
      )
    }

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
      ...(entry?.lastCacheHitRate !== undefined
        ? { lastCacheHitRate: entry.lastCacheHitRate }
        : {}),
    }
  }

  removeOverlay(ref: CliSessionRef): Promise<boolean> {
    return this.indexStore.remove(ref)
  }
}

const mergeTurnOverlays = (
  ...groups: Array<CliSessionIndexEntry['turnOverlays']>
): NonNullable<CliSessionIndexEntry['turnOverlays']> => {
  const merged: NonNullable<CliSessionIndexEntry['turnOverlays']> = []
  const indexByIdentity = new Map<string, number>()
  for (const overlay of groups.flatMap((group) => group ?? [])) {
    const identity = `${overlay.userMessage.id}:${overlay.transportHash}`
    const index = indexByIdentity.get(identity)
    if (index === undefined) {
      indexByIdentity.set(identity, merged.length)
      merged.push(overlay)
    } else {
      merged[index] = overlay
    }
  }
  return merged
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
