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
})
