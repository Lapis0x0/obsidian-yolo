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
  type CliSessionIndexEntry,
  type CliSessionIndexStore,
  createCliSessionIndexEntry,
  getCliSessionIndexKey,
} from './session-index'
import type {
  CliRuntime,
  CliRuntimeId,
  CliSessionHydration,
  CliSessionMetadata,
  CliSessionRef,
} from './types'

export type CliSessionListItem = CliSessionMetadata & {
  hasOverlay: boolean
  lastOpenedAt?: number
  isPinned: boolean
  pinnedAt?: number
}

export type CliSessionDiscoveryResult = {
  sessions: CliSessionListItem[]
  errors: Partial<Record<CliRuntimeId, string>>
}

export type OpenCliSessionOptions = {
  openedAt?: number
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const mergeOverlay = (
  metadata: CliSessionMetadata,
  overlay: CliSessionIndexEntry | undefined,
): CliSessionListItem => ({
  ...metadata,
  ...(overlay?.title?.trim()
    ? {
        title: overlay.title.trim(),
        ...(metadata.title.trim() && metadata.title.trim() !== overlay.title.trim()
          ? { preview: metadata.preview ?? metadata.title }
          : {}),
      }
    : {}),
  hasOverlay: overlay !== undefined,
  ...(overlay?.lastOpenedAt !== undefined
    ? { lastOpenedAt: overlay.lastOpenedAt }
    : {}),
  isPinned: overlay?.isPinned === true,
  ...(overlay?.pinnedAt !== undefined ? { pinnedAt: overlay.pinnedAt } : {}),
})

const compareSessions = (
  left: CliSessionListItem,
  right: CliSessionListItem,
): number => {
  if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1
  if (left.isPinned && right.isPinned) {
    const pinOrder = (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0)
    if (pinOrder !== 0) return pinOrder
  }
  return right.updatedAt - left.updatedAt
}

export class CliSessionService {
  private readonly runtimes: ReadonlyMap<CliRuntimeId, CliRuntime>

  constructor({
    app,
    runtimes,
    indexStore,
  }: {
    app: App
    runtimes: Iterable<CliRuntime>
    indexStore: CliSessionIndexStore
  }) {
    this.app = app
    this.runtimes = new Map(
      [...runtimes].map((runtime) => [runtime.runtimeId, runtime]),
    )
    this.indexStore = indexStore
  }

  private readonly indexStore: CliSessionIndexStore
  private readonly app: App

  async listSessions(): Promise<CliSessionDiscoveryResult> {
    const overlays = new Map(
      (await this.indexStore.list()).map((entry) => [
        getCliSessionIndexKey(entry),
        entry,
      ]),
    )
    const errors: Partial<Record<CliRuntimeId, string>> = {}
    const results = await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        try {
          return await runtime.listSessions()
        } catch (error) {
          errors[runtime.runtimeId] = errorMessage(error)
          return []
        }
      }),
    )

    const sessions = results
      .flat()
      .map((metadata) =>
        mergeOverlay(
          metadata,
          overlays.get(getCliSessionIndexKey(metadata.ref)),
        ),
      )
      .sort(compareSessions)
    return { sessions, errors }
  }

  async openSession(
    ref: CliSessionRef,
    options: OpenCliSessionOptions = {},
  ): Promise<CliSessionHydration> {
    const runtime = this.getRuntime(ref.runtimeId)
    const hydration = await runtime.openSession(ref)
    await this.recordOpenedSession(hydration, options)
    return hydration
  }

  async recordOpenedSession(
    hydration: CliSessionHydration,
    options: OpenCliSessionOptions = {},
  ): Promise<void> {
    const ref = hydration.ref
    await this.indexStore.update(ref, (existing) =>
      createCliSessionIndexEntry({
        runtimeId: ref.runtimeId,
        nativeSessionId: ref.nativeSessionId,
        ...(hydration.ref.sessionPathHint
          ? { sessionPathHint: hydration.ref.sessionPathHint }
          : existing?.sessionPathHint
            ? { sessionPathHint: existing.sessionPathHint }
            : {}),
        lastOpenedAt: options.openedAt ?? Date.now(),
        ...(existing?.isPinned !== undefined
          ? { isPinned: existing.isPinned }
          : {}),
        ...(existing?.pinnedAt !== undefined
          ? { pinnedAt: existing.pinnedAt }
          : {}),
        ...(existing?.userDisplayByTransportHash
          ? {
              userDisplayByTransportHash: existing.userDisplayByTransportHash,
            }
          : {}),
        ...(existing && 'modelId' in existing
          ? { modelId: existing.modelId }
          : {}),
        ...(existing && 'reasoningEffort' in existing
          ? { reasoningEffort: existing.reasoningEffort }
          : {}),
        ...(existing?.title ? { title: existing.title } : {}),
        ...(existing?.assistantId ? { assistantId: existing.assistantId } : {}),
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

  async setPinned(
    ref: CliSessionRef,
    pinned: boolean,
    pinnedAt = Date.now(),
  ): Promise<void> {
    await this.indexStore.update(ref, (existing) =>
      createCliSessionIndexEntry({
        runtimeId: ref.runtimeId,
        nativeSessionId: ref.nativeSessionId,
        ...((ref.sessionPathHint ?? existing?.sessionPathHint)
          ? {
              sessionPathHint: ref.sessionPathHint ?? existing?.sessionPathHint,
            }
          : {}),
        ...(existing?.lastOpenedAt !== undefined
          ? { lastOpenedAt: existing.lastOpenedAt }
          : {}),
        ...(existing?.userDisplayByTransportHash
          ? {
              userDisplayByTransportHash: existing.userDisplayByTransportHash,
            }
          : {}),
        isPinned: pinned,
        ...(pinned ? { pinnedAt } : {}),
        ...(existing && 'modelId' in existing
          ? { modelId: existing.modelId }
          : {}),
        ...(existing && 'reasoningEffort' in existing
          ? { reasoningEffort: existing.reasoningEffort }
          : {}),
        ...(existing?.title ? { title: existing.title } : {}),
        ...(existing?.assistantId ? { assistantId: existing.assistantId } : {}),
      }),
    )
  }

  async getOverlayTitle(ref: CliSessionRef): Promise<string | null> {
    const title = (await this.indexStore.get(ref))?.title?.trim()
    return title && title.length > 0 ? title : null
  }

  async recordTitle(ref: CliSessionRef, title: string): Promise<void> {
    const normalized = title.trim()
    if (!normalized) throw new Error('CLI session title cannot be empty.')
    await this.indexStore.update(ref, (existing) =>
      createCliSessionIndexEntry({
        ...ref,
        ...existing,
        title: normalized,
      }),
    )
  }

  /**
   * Write YOLO title to overlay, then best-effort rename the native session
   * when the current native title still looks like a placeholder.
   */
  async applyGeneratedTitle({
    ref,
    title,
  }: {
    ref: CliSessionRef
    title: string
  }): Promise<{ overlayWritten: true; nativeRenamed: boolean }> {
    await this.recordTitle(ref, title)
    try {
      const result = await this.getRuntime(
        ref.runtimeId,
      ).renameSessionIfPlaceholder(ref, title)
      return { overlayWritten: true, nativeRenamed: result === 'renamed' }
    } catch (error) {
      console.warn('[YOLO] Failed to rename native CLI session title', {
        runtimeId: ref.runtimeId,
        nativeSessionId: ref.nativeSessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return { overlayWritten: true, nativeRenamed: false }
    }
  }

  removeOverlay(ref: CliSessionRef): Promise<boolean> {
    return this.indexStore.remove(ref)
  }

  private getRuntime(runtimeId: CliRuntimeId): CliRuntime {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) throw new Error(`${runtimeId} CLI runtime is unavailable.`)
    return runtime
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
