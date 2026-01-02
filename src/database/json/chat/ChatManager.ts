import { App, normalizePath } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import { AbstractJsonRepository } from '../base'
import { CHAT_DIR, ROOT_DIR } from '../constants'
import { EmptyChatTitleException } from '../exception'

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

  constructor(app: App) {
    super(app, `${ROOT_DIR}/${CHAT_DIR}`)
  }

  protected generateFileName(chat: ChatConversation): string {
    // Format: v{schemaVersion}_{title}_{updatedAt}_{id}.json
    const encodedTitle = encodeURIComponent(chat.title)

    // 确保编码后的文件名不会过长，避免文件系统限制
    // 预留空间给版本号、时间戳、UUID和扩展名（约80字符）
    // 文件系统通常限制255字符，保守限制编码后标题为150字符
    const maxEncodedTitleLength = 150
    const truncatedEncodedTitle =
      encodedTitle.length > maxEncodedTitleLength
        ? encodedTitle.substring(0, maxEncodedTitleLength) + '...'
        : encodedTitle

    return `v${chat.schemaVersion}_${truncatedEncodedTitle}_${chat.updatedAt}_${chat.id}.json`
  }

  protected parseFileName(fileName: string): ChatConversationMetadata | null {
    // Parse: v{schemaVersion}_{title}_{updatedAt}_{id}.json
    const regex = new RegExp(
      `^v${CHAT_SCHEMA_VERSION}_(.+)_(\\d+)_([0-9a-f-]+)\\.json$`,
    )
    const match = fileName.match(regex)
    if (!match) return null

    const title = decodeURIComponent(match[1])
    const updatedAt = parseInt(match[2], 10)
    const id = match[3]

    return {
      id,
      schemaVersion: CHAT_SCHEMA_VERSION,
      title,
      updatedAt,
    }
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
  ): Promise<ChatConversation | null> {
    const chat = await this.findById(id)
    if (!chat) return null

    if (updates.title !== undefined && updates.title.length === 0) {
      throw new EmptyChatTitleException()
    }

    const updatedChat: ChatConversation = {
      ...chat,
      ...updates,
      updatedAt: Date.now(),
    }

    await this.update(chat, updatedChat)
    await this.upsertIndex(updatedChat)
    return updatedChat
  }

  public async deleteChat(id: string): Promise<boolean> {
    const allMetadata = await this.listMetadata()
    const targetMetadata = allMetadata.find((meta) => meta.id === id)
    if (!targetMetadata) return false

    await this.delete(targetMetadata.fileName)
    await this.removeFromIndex(id)
    return true
  }

  public async listChats(): Promise<ChatConversationMetadata[]> {
    const index = await this.readIndex()
    if (index) {
      const normalized = this.normalizeIndex(index)
      await this.writeIndexIfChanged(index, normalized)
      return this.sortByUpdatedAt(normalized)
    }

    const built = await this.buildIndexFromFiles()
    await this.writeIndex(built)
    return this.sortByUpdatedAt(built)
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
      console.error('[Smart Composer] Failed to read chat index', error)
      return null
    }
  }

  private async writeIndex(list: ChatConversationMetadata[]): Promise<void> {
    await this.ensureDataDir()
    const filePath = this.getIndexPath()
    await this.app.vault.adapter.write(filePath, JSON.stringify(list, null, 2))
  }

  private async writeIndexIfChanged(
    original: ChatConversationMetadata[],
    normalized: ChatConversationMetadata[],
  ): Promise<void> {
    if (original.length !== normalized.length) {
      await this.writeIndex(normalized)
      return
    }
    const originalJson = JSON.stringify(original)
    const normalizedJson = JSON.stringify(normalized)
    if (originalJson !== normalizedJson) {
      await this.writeIndex(normalized)
    }
  }

  private async buildIndexFromFiles(): Promise<ChatConversationMetadata[]> {
    const metadata = await this.listMetadata()
    const entries = await Promise.all(
      metadata.map(async (meta) => {
        const conversation = await this.read(meta.fileName)
        if (!conversation) {
          return {
            id: meta.id,
            title: meta.title,
            updatedAt: meta.updatedAt,
            schemaVersion: meta.schemaVersion,
            isPinned: false,
            pinnedAt: undefined,
          }
        }
        return {
          id: conversation.id,
          title: conversation.title,
          updatedAt: conversation.updatedAt,
          schemaVersion: conversation.schemaVersion,
          isPinned: conversation.isPinned ?? false,
          pinnedAt: conversation.pinnedAt,
        }
      }),
    )
    return this.normalizeIndex(entries)
  }

  private normalizeIndex(
    list: ChatConversationMetadata[],
  ): ChatConversationMetadata[] {
    const map = new Map<string, ChatConversationMetadata>()
    list.forEach((item) => {
      if (!item?.id) return
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
