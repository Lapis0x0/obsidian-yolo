import { App, normalizePath } from 'obsidian'
import path from 'path-browserify'
import { v4 as uuidv4 } from 'uuid'

import { ensureJsonDbRootDir } from '../../../core/paths/yoloManagedData'
import { getYoloJsonDbRootDir } from '../../../core/paths/yoloPaths'
import { AbstractJsonRepository } from '../base'
import { CHAT_DIR } from '../constants'
import { EmptyChatTitleException } from '../exception'

import { deleteEditReviewSnapshotStore } from './editReviewSnapshotStore'
import { deletePromptSnapshotStore } from './promptSnapshotStore'
import {
  CHAT_SCHEMA_VERSION,
  ChatConversation,
  ChatConversationMetadata,
} from './types'

export class ChatManager extends AbstractJsonRepository<
  ChatConversation,
  ChatConversationMetadata
> {
  private static readonly INDEX_FILE_NAME = 'chat_index.json'
  private readonly settings?: {
    yolo?: {
      baseDir?: string
    }
  } | null

  constructor(
    app: App,
    settings?: {
      yolo?: {
        baseDir?: string
      }
    } | null,
  ) {
    const normalizedSettings = settings ?? null
    super(app, `${getYoloJsonDbRootDir(settings)}/${CHAT_DIR}`, {
      prepareDataDir: async () => {
        const rootDir = await ensureJsonDbRootDir(app, normalizedSettings)
        return normalizePath(`${rootDir}/${CHAT_DIR}`)
      },
    })
    this.settings = normalizedSettings
  }

  protected generateFileName(chat: ChatConversation): string {
    return `v${chat.schemaVersion}_${chat.id}.json`
  }

  protected parseFileName(fileName: string): ChatConversationMetadata | null {
    const stableRegex = new RegExp(
      `^v${CHAT_SCHEMA_VERSION}_([0-9a-f-]+)\\.json$`,
    )
    const stableMatch = fileName.match(stableRegex)
    if (stableMatch) {
      return {
        id: stableMatch[1],
        schemaVersion: CHAT_SCHEMA_VERSION,
        title: '',
        updatedAt: 0,
      }
    }

    const legacyRegex = new RegExp(
      `^v${CHAT_SCHEMA_VERSION}_(.+)_(\\d+)_([0-9a-f-]+)\\.json$`,
    )
    const legacyMatch = fileName.match(legacyRegex)
    if (!legacyMatch) return null

    const title = this.decodeTitle(legacyMatch[1])
    const updatedAt = parseInt(legacyMatch[2], 10)
    const id = legacyMatch[3]

    return {
      id,
      schemaVersion: CHAT_SCHEMA_VERSION,
      title,
      updatedAt,
    }
  }

  private decodeTitle(encodedTitle: string): string {
    let candidate = encodedTitle
    for (let i = 0; i < 3; i += 1) {
      try {
        return decodeURIComponent(candidate)
      } catch (_error) {
        candidate = candidate.slice(0, -1)
      }
    }
    return encodedTitle
  }

  public async createChat(
    initialData: Partial<ChatConversation>,
  ): Promise<ChatConversation> {
    if (initialData.title && initialData.title.length === 0) {
      throw new EmptyChatTitleException()
    }

    const now = Date.now()
    const newChat: ChatConversation = {
      id: uuidv4(),
      title: 'New chat',
      messages: [],
      createdAt: now,
      updatedAt: now,
      schemaVersion: CHAT_SCHEMA_VERSION,
      ...initialData,
    }

    await this.create(newChat)
    await this.upsertIndex(newChat)
    return newChat
  }

  public async findById(id: string): Promise<ChatConversation | null> {
    const allMetadata = await this.listMetadata()
    const targetMetadata = allMetadata.find((meta) => meta.id === id)

    if (!targetMetadata) return null

    return this.read(targetMetadata.fileName)
  }

  public async updateChat(
    id: string,
    updates: Partial<
      Omit<ChatConversation, 'id' | 'createdAt' | 'updatedAt' | 'schemaVersion'>
    >,
    options?: {
      touchUpdatedAt?: boolean
    },
  ): Promise<ChatConversation | null> {
    const allMetadata = await this.listMetadata()
    const targetMetadata = allMetadata.find((meta) => meta.id === id)
    if (!targetMetadata) return null
    const chat = await this.read(targetMetadata.fileName)
    if (!chat) return null

    if (updates.title !== undefined && updates.title.length === 0) {
      throw new EmptyChatTitleException()
    }

    const touchUpdatedAt = options?.touchUpdatedAt !== false
    const updatedChat: ChatConversation = {
      ...chat,
      ...updates,
      updatedAt: touchUpdatedAt ? Date.now() : chat.updatedAt,
    }

    const nextFileName = this.generateFileName(updatedChat)
    const nextPath = normalizePath(path.join(this.dataDir, nextFileName))
    await this.writeFile(nextPath, JSON.stringify(updatedChat, null, 2))
    if (targetMetadata.fileName !== nextFileName) {
      await this.delete(targetMetadata.fileName)
    }
    await this.upsertIndex(updatedChat)
    return updatedChat
  }

  public async deleteChat(id: string): Promise<boolean> {
    const allMetadata = await this.listMetadata()
    const targetMetadata = allMetadata.find((meta) => meta.id === id)
    if (!targetMetadata) return false

    await this.delete(targetMetadata.fileName)
    await deletePromptSnapshotStore(this.app, id, this.settings)
    await deleteEditReviewSnapshotStore(this.app, id, this.settings)
    await this.removeFromIndex(id)
    return true
  }

  public async listChats(): Promise<ChatConversationMetadata[]> {
    // The conversation files on disk are the source of truth; chat_index.json
    // is only a metadata cache that lets us skip reading every file on each
    // list. Reconcile against the directory so a missing / empty / stale index
    // can never hide conversations that actually exist on disk (e.g. after a
    // manual folder copy or an interrupted sync).
    const onDisk = await this.listMetadata()
    const cachedList = this.normalizeIndex((await this.readIndex()) ?? [])
    const cachedById = new Map(cachedList.map((entry) => [entry.id, entry]))

    // normalizeIndex dedups by id (a conversation may briefly have both a
    // stable and a legacy filename), matching the previous rebuild behavior.
    const reconciled = this.normalizeIndex(
      await Promise.all(
        onDisk.map(async (meta) => {
          // Trust the cache only for non-degenerate entries. A real chat never
          // has an empty title (createChat/updateChat reject it), so an empty
          // title marks a placeholder previously written for an unreadable
          // file — fall through and re-read it so it can self-heal.
          const cached = cachedById.get(meta.id)
          if (cached && cached.title) return cached
          const conversation = await this.readSafe(meta.fileName)
          return this.toMetadata(conversation ?? meta)
        }),
      ),
    )

    await this.writeIndexIfChanged(cachedList, reconciled)
    return this.sortByUpdatedAt(reconciled)
  }

  private async readSafe(fileName: string): Promise<ChatConversation | null> {
    try {
      return await this.read(fileName)
    } catch (error) {
      // A single corrupt / half-written conversation file must not reject the
      // whole list; surface a filename-derived placeholder instead.
      console.error('[YOLO] Failed to read chat file', fileName, error)
      return null
    }
  }

  private async readIndex(): Promise<ChatConversationMetadata[] | null> {
    const filePath = this.getIndexPath()
    if (!(await this.app.vault.adapter.exists(filePath))) {
      return null
    }
    try {
      const content = await this.app.vault.adapter.read(filePath)
      const parsed = JSON.parse(content) as ChatConversationMetadata[]
      return Array.isArray(parsed) ? parsed : null
    } catch (error) {
      console.error('[YOLO] Failed to read chat index', error)
      return null
    }
  }

  private async writeIndex(list: ChatConversationMetadata[]): Promise<void> {
    await this.ensureDataDir()
    const filePath = this.getIndexPath()
    await this.writeFile(filePath, JSON.stringify(list, null, 2))
  }

  private async writeIndexIfChanged(
    previous: ChatConversationMetadata[],
    next: ChatConversationMetadata[],
  ): Promise<void> {
    // Compare by content (id-sorted) so that a pure ordering difference between
    // the cached index and the disk-derived list does not trigger a rewrite.
    const previousJson = JSON.stringify(this.sortById(previous))
    const nextJson = JSON.stringify(this.sortById(next))
    if (previousJson !== nextJson) {
      await this.writeIndex(next)
    }
  }

  private sortById(
    list: ChatConversationMetadata[],
  ): ChatConversationMetadata[] {
    return [...list].sort((a, b) => a.id.localeCompare(b.id))
  }

  private toMetadata(
    source: Pick<
      ChatConversation,
      'id' | 'title' | 'updatedAt' | 'schemaVersion'
    > & { isPinned?: boolean; pinnedAt?: number },
  ): ChatConversationMetadata {
    return {
      id: source.id,
      title: source.title,
      updatedAt: source.updatedAt,
      schemaVersion: source.schemaVersion,
      isPinned: source.isPinned ?? false,
      pinnedAt: source.pinnedAt,
    }
  }

  private normalizeIndex(
    list: ChatConversationMetadata[],
  ): ChatConversationMetadata[] {
    const map = new Map<string, ChatConversationMetadata>()
    list.forEach((item) => {
      // Drop garbage entries (e.g. a hand-corrupted index with a non-string
      // id) at the source so downstream id handling stays safe.
      if (!item || typeof item.id !== 'string' || item.id.length === 0) return
      const existing = map.get(item.id)
      if (!existing) {
        map.set(item.id, item)
        return
      }
      const preferred = this.pickPreferredIndexEntry(existing, item)
      map.set(item.id, preferred)
    })
    return Array.from(map.values())
  }

  private pickPreferredIndexEntry(
    current: ChatConversationMetadata,
    next: ChatConversationMetadata,
  ): ChatConversationMetadata {
    const currentUpdated = current.updatedAt ?? 0
    const nextUpdated = next.updatedAt ?? 0
    if (nextUpdated > currentUpdated) return next
    if (nextUpdated < currentUpdated) return current

    const currentPinnedAt = current.pinnedAt ?? 0
    const nextPinnedAt = next.pinnedAt ?? 0
    if (nextPinnedAt > currentPinnedAt) return next
    if (nextPinnedAt < currentPinnedAt) return current

    if (next.isPinned && !current.isPinned) return next
    return current
  }

  private sortByUpdatedAt(
    list: ChatConversationMetadata[],
  ): ChatConversationMetadata[] {
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private async upsertIndex(chat: ChatConversation): Promise<void> {
    const index = (await this.readIndex()) ?? []
    const normalized = this.normalizeIndex(index)
    const targetIndex = normalized.findIndex((item) => item.id === chat.id)
    const entry: ChatConversationMetadata = {
      id: chat.id,
      title: chat.title,
      updatedAt: chat.updatedAt,
      schemaVersion: chat.schemaVersion,
      isPinned: chat.isPinned ?? false,
      pinnedAt: chat.pinnedAt,
    }
    if (targetIndex === -1) {
      normalized.push(entry)
    } else {
      normalized[targetIndex] = entry
    }
    await this.writeIndex(normalized)
  }

  private async removeFromIndex(id: string): Promise<void> {
    const index = await this.readIndex()
    if (!index) return
    const next = index.filter((item) => item.id !== id)
    await this.writeIndex(next)
  }

  private getIndexPath(): string {
    return normalizePath(`${this.dataDir}/${ChatManager.INDEX_FILE_NAME}`)
  }

  private async ensureDataDir(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.dataDir))) {
      await this.app.vault.adapter.mkdir(this.dataDir)
    }
  }
}
