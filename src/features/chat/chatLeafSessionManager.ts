import { App, TFile, TFolder, WorkspaceLeaf, WorkspaceWindow } from 'obsidian'

import { CHAT_VIEW_TYPE } from '../../constants'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type {
  MentionableBlockData,
  MentionableImage,
} from '../../types/mentionable'

export type ChatLeafPlacement = 'sidebar' | 'split' | 'tab' | 'window'

export type PendingChatOpenPayload = {
  selectedBlock?: MentionableBlockData
  initialConversationId?: string
  prefillText?: string
  autoSend?: boolean
  fileToAdd?: TFile
  folderToAdd?: TFolder
  imageToAdd?: MentionableImage
  placement?: ChatLeafPlacement
}

type ChatLeafSummary = {
  currentConversationId?: string
  currentConversationTitle?: string
  currentModelId?: string
  currentOverrides?: ConversationOverrideSettings
}

type ChatLeafRecord = {
  leaf: WorkspaceLeaf
  placement: ChatLeafPlacement
  lastActiveAt: number
  lastInteractionAt: number
  summary: ChatLeafSummary
}

type ResolveTargetLeafOptions = {
  placement?: ChatLeafPlacement
  preferActiveChatLeaf?: boolean
}

export class ChatLeafSessionManager {
  private readonly records = new Map<WorkspaceLeaf, ChatLeafRecord>()
  private readonly pendingPayloads = new Map<
    WorkspaceLeaf,
    PendingChatOpenPayload
  >()

  constructor(private readonly app: App) {}

  registerLeaf(
    leaf: WorkspaceLeaf,
    placement?: ChatLeafPlacement,
  ): ChatLeafRecord {
    const now = Date.now()
    const existing = this.records.get(leaf)
    const nextPlacement =
      placement ?? existing?.placement ?? this.inferPlacement(leaf)

    const record: ChatLeafRecord = {
      leaf,
      placement: nextPlacement,
      lastActiveAt: existing?.lastActiveAt ?? now,
      lastInteractionAt: existing?.lastInteractionAt ?? now,
      summary: existing?.summary ?? {},
    }
    this.records.set(leaf, record)
    return record
  }

  unregisterLeaf(leaf: WorkspaceLeaf): void {
    this.records.delete(leaf)
    this.pendingPayloads.delete(leaf)
  }

  setPendingPayload(
    leaf: WorkspaceLeaf,
    payload: PendingChatOpenPayload,
  ): void {
    this.pendingPayloads.set(leaf, payload)
    if (payload.placement) {
      this.registerLeaf(leaf, payload.placement)
    }
  }

  consumePendingPayload(
    leaf: WorkspaceLeaf,
  ): PendingChatOpenPayload | undefined {
    const payload = this.pendingPayloads.get(leaf)
    this.pendingPayloads.delete(leaf)
    return payload
  }

  touchLeafActive(leaf: WorkspaceLeaf): void {
    const record = this.records.get(leaf)
    if (!record) return
    record.lastActiveAt = Date.now()
  }

  touchLeafInteracted(leaf: WorkspaceLeaf): void {
    const record = this.records.get(leaf)
    if (!record) return
    const now = Date.now()
    record.lastActiveAt = now
    record.lastInteractionAt = now
  }

  updateLeafSummary(leaf: WorkspaceLeaf, summary: ChatLeafSummary): void {
    const record = this.records.get(leaf)
    if (!record) return
    record.summary = summary
  }

  getLeafSummary(leaf: WorkspaceLeaf): ChatLeafSummary | undefined {
    return this.records.get(leaf)?.summary
  }

  getLeafPlacement(leaf: WorkspaceLeaf): ChatLeafPlacement | undefined {
    return this.records.get(leaf)?.placement
  }

  inferLeafPlacement(leaf: WorkspaceLeaf): ChatLeafPlacement {
    return this.inferPlacement(leaf)
  }

  resolveTargetLeaf(
    options: ResolveTargetLeafOptions = {},
  ): WorkspaceLeaf | null {
    const preferActiveChatLeaf = options.preferActiveChatLeaf ?? true
    const candidates = this.getRegisteredLeaves(options.placement)

    if (preferActiveChatLeaf) {
      const activeLeaf = this.app.workspace.getMostRecentLeaf()
      if (activeLeaf && candidates.includes(activeLeaf)) {
        return activeLeaf
      }
    }

    if (candidates.length === 0) {
      return null
    }

    return (
      candidates.sort((left, right) => {
        const leftRecord = this.records.get(left)
        const rightRecord = this.records.get(right)
        const leftScore = Math.max(
          leftRecord?.lastInteractionAt ?? 0,
          leftRecord?.lastActiveAt ?? 0,
        )
        const rightScore = Math.max(
          rightRecord?.lastInteractionAt ?? 0,
          rightRecord?.lastActiveAt ?? 0,
        )
        return rightScore - leftScore
      })[0] ?? null
    )
  }

  getAllLeafRecords(): Array<{
    leaf: WorkspaceLeaf
    placement: ChatLeafPlacement
    currentConversationId?: string
  }> {
    return Array.from(this.records.values()).map((record) => ({
      leaf: record.leaf,
      placement: record.placement,
      currentConversationId: record.summary.currentConversationId,
    }))
  }

  private getRegisteredLeaves(placement?: ChatLeafPlacement): WorkspaceLeaf[] {
    return Array.from(this.records.values())
      .filter((record) => record.leaf.view.getViewType() === CHAT_VIEW_TYPE)
      .filter((record) => (placement ? record.placement === placement : true))
      .map((record) => record.leaf)
      .filter((leaf) => leaf.view.getViewType() === CHAT_VIEW_TYPE)
  }

  private inferPlacement(leaf: WorkspaceLeaf): ChatLeafPlacement {
    const container = leaf.getContainer()
    if (container instanceof WorkspaceWindow) {
      return 'window'
    }

    let parent: unknown = leaf.parent
    while (parent) {
      if (parent === this.app.workspace.rightSplit) {
        return 'sidebar'
      }
      parent =
        typeof parent === 'object' && parent !== null && 'parent' in parent
          ? (parent as { parent?: unknown }).parent
          : null
    }

    return 'tab'
  }
}
