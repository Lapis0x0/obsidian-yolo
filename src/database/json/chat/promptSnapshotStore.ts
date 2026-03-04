import { App, normalizePath } from 'obsidian'
import path from 'path-browserify'

import {
  SerializedChatMessage,
  SerializedChatUserMessage,
} from '../../../types/chat'
import { ContentPart } from '../../../types/llm/request'
import { ROOT_DIR, CHAT_DIR } from '../constants'

type PromptSnapshotEntry = {
  hash: string
  content: string | ContentPart[]
  createdAt: number
  updatedAt: number
}

type PromptSnapshotStore = {
  schemaVersion: 1
  entries: Record<string, PromptSnapshotEntry>
}

const SNAPSHOT_DIR = 'chat_snapshots'

const EMPTY_STORE: PromptSnapshotStore = {
  schemaVersion: 1,
  entries: {},
}

const getSnapshotDirPath = (): string =>
  normalizePath(path.join(ROOT_DIR, CHAT_DIR, SNAPSHOT_DIR))

const getSnapshotFilePath = (conversationId: string): string =>
  normalizePath(path.join(getSnapshotDirPath(), `${conversationId}.json`))

const shouldStorePromptSnapshot = (
  message: SerializedChatUserMessage,
): boolean =>
  message.mentionables.some(
    (mentionable) =>
      mentionable.type === 'file' ||
      mentionable.type === 'folder' ||
      mentionable.type === 'block' ||
      mentionable.type === 'url' ||
      mentionable.type === 'current-file' ||
      mentionable.type === 'vault',
  )

const fnv1aHash = (text: string): string => {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const buildSnapshotHash = (content: string | ContentPart[]): string =>
  fnv1aHash(JSON.stringify(content))

const ensureSnapshotDir = async (app: App): Promise<void> => {
  const snapshotDir = getSnapshotDirPath()
  if (!(await app.vault.adapter.exists(snapshotDir))) {
    await app.vault.adapter.mkdir(snapshotDir)
  }
}

const readSnapshotStore = async (
  app: App,
  conversationId: string,
): Promise<PromptSnapshotStore> => {
  const filePath = getSnapshotFilePath(conversationId)
  if (!(await app.vault.adapter.exists(filePath))) {
    return EMPTY_STORE
  }

  try {
    const content = await app.vault.adapter.read(filePath)
    const parsed = JSON.parse(content) as PromptSnapshotStore
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
      return EMPTY_STORE
    }
    return {
      schemaVersion: 1,
      entries: parsed.entries,
    }
  } catch (error) {
    console.error('[Smart Composer] Failed to read prompt snapshots', error)
    return EMPTY_STORE
  }
}

const writeSnapshotStore = async (
  app: App,
  conversationId: string,
  store: PromptSnapshotStore,
): Promise<void> => {
  await ensureSnapshotDir(app)
  const filePath = getSnapshotFilePath(conversationId)
  await app.vault.adapter.write(filePath, JSON.stringify(store, null, 2))
}

export const compactConversationMessagesForStorage = async ({
  app,
  conversationId,
  messages,
  previousMessages,
}: {
  app: App
  conversationId: string
  messages: SerializedChatMessage[]
  previousMessages?: SerializedChatMessage[]
}): Promise<SerializedChatMessage[]> => {
  const store = await readSnapshotStore(app, conversationId)
  const nextEntries = { ...store.entries }
  const usedHashes = new Set<string>()
  let changed = false
  const previousSnapshotRefByMessageId = new Map<string, string>()

  previousMessages?.forEach((message) => {
    if (message.role !== 'user') {
      return
    }
    if (!message.snapshotRef?.hash) {
      return
    }
    previousSnapshotRefByMessageId.set(message.id, message.snapshotRef.hash)
  })

  const compactedMessages = messages.map((message): SerializedChatMessage => {
    if (message.role !== 'user') {
      return message
    }

    const userMessage = message
    if (userMessage.promptContent && shouldStorePromptSnapshot(userMessage)) {
      const hash = buildSnapshotHash(userMessage.promptContent)
      const now = Date.now()
      const existing = nextEntries[hash]
      if (!existing) {
        nextEntries[hash] = {
          hash,
          content: userMessage.promptContent,
          createdAt: now,
          updatedAt: now,
        }
        changed = true
      }
      usedHashes.add(hash)

      return {
        ...userMessage,
        promptContent: null,
        snapshotRef: { hash },
      }
    }

    if (userMessage.snapshotRef?.hash) {
      if (shouldStorePromptSnapshot(userMessage)) {
        usedHashes.add(userMessage.snapshotRef.hash)
        return {
          ...userMessage,
          promptContent: null,
        }
      }
      changed = true
      return {
        ...userMessage,
        promptContent: null,
        snapshotRef: undefined,
      }
    }

    if (shouldStorePromptSnapshot(userMessage)) {
      const previousHash = previousSnapshotRefByMessageId.get(userMessage.id)
      if (previousHash && nextEntries[previousHash]) {
        usedHashes.add(previousHash)
        return {
          ...userMessage,
          promptContent: null,
          snapshotRef: { hash: previousHash },
        }
      }
    }

    return {
      ...userMessage,
      promptContent: null,
      snapshotRef: shouldStorePromptSnapshot(userMessage)
        ? userMessage.snapshotRef
        : undefined,
    }
  })

  for (const hash of Object.keys(nextEntries)) {
    if (usedHashes.has(hash)) {
      continue
    }
    delete nextEntries[hash]
    changed = true
  }

  if (changed) {
    await writeSnapshotStore(app, conversationId, {
      schemaVersion: 1,
      entries: nextEntries,
    })
  }

  return compactedMessages
}

export const readPromptSnapshotContent = async ({
  app,
  conversationId,
  hash,
}: {
  app: App
  conversationId: string
  hash: string
}): Promise<string | ContentPart[] | null> => {
  const store = await readSnapshotStore(app, conversationId)
  return store.entries[hash]?.content ?? null
}

export const readPromptSnapshotEntries = async ({
  app,
  conversationId,
}: {
  app: App
  conversationId: string
}): Promise<Record<string, string | ContentPart[]>> => {
  const store = await readSnapshotStore(app, conversationId)
  const entries: Record<string, string | ContentPart[]> = {}
  Object.keys(store.entries).forEach((hash) => {
    entries[hash] = store.entries[hash].content
  })
  return entries
}

export const deletePromptSnapshotStore = async (
  app: App,
  conversationId: string,
): Promise<void> => {
  const filePath = getSnapshotFilePath(conversationId)
  if (await app.vault.adapter.exists(filePath)) {
    await app.vault.adapter.remove(filePath)
  }
}

export const clearAllPromptSnapshotStores = async (app: App): Promise<void> => {
  const snapshotDir = getSnapshotDirPath()
  if (!(await app.vault.adapter.exists(snapshotDir))) {
    return
  }

  const listing = await app.vault.adapter.list(snapshotDir)
  for (const filePath of listing.files) {
    await app.vault.adapter.remove(filePath)
  }
}
