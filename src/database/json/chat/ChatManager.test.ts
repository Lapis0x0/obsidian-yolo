import { App } from 'obsidian'

import { ChatManager } from './ChatManager'
import { CHAT_SCHEMA_VERSION, ChatConversation } from './types'

class TestableChatManager extends ChatManager {
  public generateFileNameForTest(chat: ChatConversation): string {
    return this.generateFileName(chat)
  }

  public parseFileNameForTest(fileName: string) {
    return this.parseFileName(fileName)
  }
}

const mockAdapter = {
  exists: jest.fn().mockResolvedValue(true),
  mkdir: jest.fn().mockResolvedValue(undefined),
  read: jest.fn().mockResolvedValue(''),
  write: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined),
  list: jest.fn().mockResolvedValue({ files: [], folders: [] }),
}

const mockVault = {
  adapter: mockAdapter,
}

const mockApp = {
  vault: mockVault,
} as unknown as App

const CHATS_DIR = 'YOLO/.yolo_json_db/chats'

function createFakeFs(initial: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(initial))
  const dirs = new Set<string>()
  const registerParents = (p: string) => {
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }
  files.forEach((_value, key) => registerParents(key))

  const adapter = {
    exists: jest.fn(async (p: string) => files.has(p) || dirs.has(p)),
    mkdir: jest.fn(async (p: string) => {
      dirs.add(p)
    }),
    read: jest.fn(async (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
      return files.get(p) as string
    }),
    write: jest.fn(async (p: string, content: string) => {
      files.set(p, content)
      registerParents(p)
    }),
    remove: jest.fn(async (p: string) => {
      files.delete(p)
    }),
    list: jest.fn(async (dir: string) => {
      const fileList: string[] = []
      const folderSet = new Set<string>()
      files.forEach((_value, key) => {
        if (!key.startsWith(`${dir}/`)) return
        const rest = key.slice(dir.length + 1)
        if (rest.includes('/')) {
          folderSet.add(`${dir}/${rest.split('/')[0]}`)
        } else {
          fileList.push(key)
        }
      })
      return { files: fileList, folders: Array.from(folderSet) }
    }),
    stat: jest.fn(async (p: string) => ({
      type: dirs.has(p) ? 'folder' : 'file',
    })),
  }

  const app = { vault: { adapter } } as unknown as App
  return { app, adapter, files }
}

function makeConversation(
  id: string,
  title: string,
  updatedAt: number,
): ChatConversation {
  return {
    id,
    title,
    messages: [],
    createdAt: updatedAt,
    updatedAt,
    schemaVersion: CHAT_SCHEMA_VERSION,
  }
}

describe('ChatManager', () => {
  let chatManager: TestableChatManager

  beforeEach(() => {
    chatManager = new TestableChatManager(mockApp)
  })

  describe('filename generation and parsing', () => {
    test('should generate stable filename by conversation id', () => {
      const chat: ChatConversation = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        title: 'Any Title',
        messages: [],
        createdAt: 1620000000000,
        updatedAt: 1620000000000,
        schemaVersion: CHAT_SCHEMA_VERSION,
      }

      const fileName = chatManager.generateFileNameForTest(chat)
      expect(fileName).toBe(`v${CHAT_SCHEMA_VERSION}_${chat.id}.json`)

      const metadata = chatManager.parseFileNameForTest(fileName)
      expect(metadata).not.toBeNull()
      if (metadata) {
        expect(metadata.id).toBe(chat.id)
        expect(metadata.title).toBe('')
        expect(metadata.updatedAt).toBe(0)
        expect(metadata.schemaVersion).toBe(chat.schemaVersion)
      }
    })

    test('should parse legacy filename format', () => {
      const title = 'Legacy Chat Title'
      const encodedTitle = encodeURIComponent(title)
      const updatedAt = 1620000000000
      const id = '123e4567-e89b-12d3-a456-426614174000'
      const legacyFileName = `v${CHAT_SCHEMA_VERSION}_${encodedTitle}_${updatedAt}_${id}.json`

      const metadata = chatManager.parseFileNameForTest(legacyFileName)
      expect(metadata).not.toBeNull()
      if (metadata) {
        expect(metadata.id).toBe(id)
        expect(metadata.title).toBe(title)
        expect(metadata.updatedAt).toBe(updatedAt)
        expect(metadata.schemaVersion).toBe(CHAT_SCHEMA_VERSION)
      }
    })
  })

  describe('listChats reconciliation', () => {
    const idA = '123e4567-e89b-12d3-a456-426614174000'
    const idB = 'abcdef01-2345-6789-abcd-ef0123456789'

    test('rebuilds from disk when the index is an empty array', async () => {
      // Regression: a stale/empty chat_index.json must not hide conversation
      // files that exist on disk (e.g. after a manual folder copy).
      const conversation = makeConversation(idA, 'Recovered chat', 1000)
      const { app, adapter } = createFakeFs({
        [`${CHATS_DIR}/chat_index.json`]: '[]',
        [`${CHATS_DIR}/v1_${idA}.json`]: JSON.stringify(conversation),
      })
      const manager = new ChatManager(app)

      const result = await manager.listChats()

      expect(result.map((entry) => entry.id)).toEqual([idA])
      expect(result[0].title).toBe('Recovered chat')
      // The recovered entry should be written back into the index.
      const indexWrite = adapter.write.mock.calls.find(
        ([path]) => path === `${CHATS_DIR}/chat_index.json`,
      )
      expect(indexWrite).toBeDefined()
      expect(JSON.parse(indexWrite?.[1] as string)).toHaveLength(1)
    })

    test('drops index entries whose conversation file is gone', async () => {
      const { app } = createFakeFs({
        [`${CHATS_DIR}/chat_index.json`]: JSON.stringify([
          { id: 'ghost', title: 'Ghost', updatedAt: 5, schemaVersion: 1 },
        ]),
      })
      const manager = new ChatManager(app)

      const result = await manager.listChats()

      expect(result).toEqual([])
    })

    test('uses cached metadata without reading the conversation file', async () => {
      const conversation = makeConversation(idA, 'On-disk title', 10)
      const { app, adapter } = createFakeFs({
        [`${CHATS_DIR}/chat_index.json`]: JSON.stringify([
          {
            id: idA,
            title: 'Cached title',
            updatedAt: 10,
            schemaVersion: CHAT_SCHEMA_VERSION,
          },
        ]),
        [`${CHATS_DIR}/v1_${idA}.json`]: JSON.stringify(conversation),
      })
      const manager = new ChatManager(app)

      const result = await manager.listChats()

      expect(result[0].title).toBe('Cached title')
      expect(adapter.read).not.toHaveBeenCalledWith(
        `${CHATS_DIR}/v1_${idA}.json`,
      )
    })

    test('surfaces a placeholder instead of rejecting on a corrupt file', async () => {
      const { app } = createFakeFs({
        [`${CHATS_DIR}/chat_index.json`]: '[]',
        [`${CHATS_DIR}/v1_${idA}.json`]: 'not valid json {{{',
      })
      const manager = new ChatManager(app)

      const result = await manager.listChats()

      expect(result.map((entry) => entry.id)).toEqual([idA])
    })

    test('does not crash on a corrupt index with a non-string id', async () => {
      const conversation = makeConversation(idA, 'Healthy chat', 10)
      const { app } = createFakeFs({
        [`${CHATS_DIR}/chat_index.json`]: JSON.stringify([
          { id: 1, title: 'x' },
        ]),
        [`${CHATS_DIR}/v1_${idA}.json`]: JSON.stringify(conversation),
      })
      const manager = new ChatManager(app)

      const result = await manager.listChats()

      expect(result.map((entry) => entry.id)).toEqual([idA])
      expect(result[0].title).toBe('Healthy chat')
    })

    test('sorts reconciled entries by updatedAt descending', async () => {
      const older = makeConversation(idA, 'Older', 100)
      const newer = makeConversation(idB, 'Newer', 200)
      const { app } = createFakeFs({
        [`${CHATS_DIR}/chat_index.json`]: '[]',
        [`${CHATS_DIR}/v1_${idA}.json`]: JSON.stringify(older),
        [`${CHATS_DIR}/v1_${idB}.json`]: JSON.stringify(newer),
      })
      const manager = new ChatManager(app)

      const result = await manager.listChats()

      expect(result.map((entry) => entry.id)).toEqual([idB, idA])
    })
  })
})
