import { createObsidianRuntimeChat } from './obsidianRuntimeChat'
import { ChatManager } from '../../database/json/chat/ChatManager'
import { compactConversationMessagesForStorage } from '../../database/json/chat/promptSnapshotStore'

jest.mock('../../database/json/chat/ChatManager')
jest.mock('../../core/agent/conversationPersistence', () => ({
  serializeChatMessage: (msg: any) => ({ ...msg, _serialized: true }),
}))
jest.mock('../../database/json/chat/promptSnapshotStore', () => ({
  compactConversationMessagesForStorage: jest.fn(async ({ messages }: { messages: any[] }) => messages),
}))

const MockChatManager = ChatManager as jest.MockedClass<typeof ChatManager>
const mockCompactConversationMessagesForStorage =
  compactConversationMessagesForStorage as jest.MockedFunction<
    typeof compactConversationMessagesForStorage
  >

describe('createObsidianRuntimeChat', () => {
  const mockApp = {} as any
  let mockSettings: any
  let chat: ReturnType<typeof createObsidianRuntimeChat>

  beforeEach(() => {
    jest.clearAllMocks()
    mockSettings = { version: 50 }
    mockCompactConversationMessagesForStorage.mockImplementation(
      async ({ messages }) => messages,
    )
    MockChatManager.prototype.listChats = jest.fn()
    MockChatManager.prototype.findById = jest.fn()
    MockChatManager.prototype.updateChat = jest.fn()
    MockChatManager.prototype.createChat = jest.fn()
    MockChatManager.prototype.deleteChat = jest.fn()

    chat = createObsidianRuntimeChat({
      app: mockApp,
      settings: mockSettings,
    } as any)
  })

  describe('list', () => {
    it('returns chat list from ChatManager', async () => {
      const mockList = [
        { id: '1', title: 'Chat 1', updatedAt: 1000, schemaVersion: 1 },
      ]
      MockChatManager.prototype.listChats = jest.fn().mockResolvedValue(mockList)

      const result = await chat.list()

      expect(MockChatManager.prototype.listChats).toHaveBeenCalled()
      expect(result).toEqual(mockList)
    })
  })

  describe('get', () => {
    it('returns chat record when found', async () => {
      const mockChat = {
        id: 'abc',
        title: 'Test',
        messages: [{ role: 'user', content: 'Hello' }],
        overrides: null,
        conversationModelId: 'gpt-4',
        messageModelMap: { user1: 'gpt-4' },
        activeBranchByUserMessageId: { user1: 'branch-a' },
        assistantGroupBoundaryMessageIds: ['assistant-1'],
        reasoningLevel: 'high',
        compaction: [{ summary: 'summary-1' }],
        updatedAt: 2000,
      }
      MockChatManager.prototype.findById = jest.fn().mockResolvedValue(mockChat)

      const result = await chat.get('abc')

      expect(result).toEqual({
        id: 'abc',
        title: 'Test',
        messages: [
          {
            role: 'user',
            content: 'Hello',
            promptContent: undefined,
            snapshotRef: undefined,
            id: undefined,
            mentionables: [],
            selectedSkills: [],
            selectedModelIds: [],
            reasoningLevel: undefined,
          },
        ],
        overrides: null,
        conversationModelId: 'gpt-4',
        messageModelMap: { user1: 'gpt-4' },
        activeBranchByUserMessageId: { user1: 'branch-a' },
        assistantGroupBoundaryMessageIds: ['assistant-1'],
        reasoningLevel: 'high',
        compaction: [{ summary: 'summary-1' }],
        updatedAt: 2000,
      })
    })

    it('returns null when chat not found', async () => {
      MockChatManager.prototype.findById = jest.fn().mockResolvedValue(null)

      const result = await chat.get('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('save', () => {
    it('creates new chat when id does not exist', async () => {
      MockChatManager.prototype.findById = jest.fn().mockResolvedValue(null)
      MockChatManager.prototype.createChat = jest.fn().mockResolvedValue(undefined)

      await chat.save({ id: 'new', messages: [{ role: 'user', content: 'Hi' } as any] })

      expect(MockChatManager.prototype.createChat).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'new' }),
      )
    })

    it('updates existing chat when id exists', async () => {
      MockChatManager.prototype.findById = jest
        .fn()
        .mockResolvedValue({
          id: 'existing',
          title: 'Old',
          messages: [{ role: 'user', content: 'Old' }],
        })
      MockChatManager.prototype.updateChat = jest.fn().mockResolvedValue(undefined)

      await chat.save({
        id: 'existing',
        messages: [{ role: 'user', content: 'Updated' } as any],
        messageModelMap: { user1: 'gpt-5' },
        activeBranchByUserMessageId: { user1: 'branch-a' },
        assistantGroupBoundaryMessageIds: ['assistant-1'],
        reasoningLevel: 'high',
        compaction: [{ summary: 'summary-1' }] as any,
      })

      expect(MockChatManager.prototype.updateChat).toHaveBeenCalledWith(
        'existing',
        expect.objectContaining({
          messageModelMap: { user1: 'gpt-5' },
          activeBranchByUserMessageId: { user1: 'branch-a' },
          assistantGroupBoundaryMessageIds: ['assistant-1'],
          reasoningLevel: 'high',
          compaction: [{ summary: 'summary-1' }],
        }),
        expect.objectContaining({}),
      )
    })

    it('preserves existing optional fields when save input leaves them undefined', async () => {
      MockChatManager.prototype.findById = jest.fn().mockResolvedValue({
        id: 'existing',
        title: 'Old',
        messages: [{ role: 'user', content: 'Old' }],
        overrides: { stream: false },
        conversationModelId: 'model-a',
        messageModelMap: { user1: 'model-a' },
        activeBranchByUserMessageId: { user1: 'branch-a' },
        assistantGroupBoundaryMessageIds: ['assistant-1'],
        reasoningLevel: 'high',
        compaction: [{ summary: 'existing-summary' }],
      })
      MockChatManager.prototype.updateChat = jest.fn().mockResolvedValue(undefined)

      await chat.save({
        id: 'existing',
        messages: [{ role: 'user', content: 'Updated' } as any],
      })

      expect(MockChatManager.prototype.updateChat).toHaveBeenCalledWith(
        'existing',
        expect.objectContaining({
          overrides: { stream: false },
          conversationModelId: 'model-a',
          messageModelMap: { user1: 'model-a' },
          activeBranchByUserMessageId: { user1: 'branch-a' },
          assistantGroupBoundaryMessageIds: ['assistant-1'],
          reasoningLevel: 'high',
          compaction: [{ summary: 'existing-summary' }],
        }),
        { touchUpdatedAt: undefined },
      )
    })

    it('passes touchUpdatedAt option', async () => {
      MockChatManager.prototype.findById = jest
        .fn()
        .mockResolvedValue({ id: 'existing', title: 'Old' })

      await chat.save({
        id: 'existing',
        messages: [],
        touchUpdatedAt: false,
      })

      expect(MockChatManager.prototype.updateChat).toHaveBeenCalledWith(
        'existing',
        expect.anything(),
        { touchUpdatedAt: false },
      )
    })
  })

  describe('delete', () => {
    it('deletes chat by id', async () => {
      await chat.delete('abc')

      expect(MockChatManager.prototype.deleteChat).toHaveBeenCalledWith('abc')
    })
  })

  describe('togglePinned', () => {
    it('toggles pinned state from false to true', async () => {
      MockChatManager.prototype.findById = jest
        .fn()
        .mockResolvedValue({ id: 'abc', isPinned: false })

      await chat.togglePinned('abc')

      expect(MockChatManager.prototype.updateChat).toHaveBeenCalledWith(
        'abc',
        expect.objectContaining({ isPinned: true, pinnedAt: expect.any(Number) }),
      )
    })

    it('toggles pinned state from true to false', async () => {
      MockChatManager.prototype.findById = jest
        .fn()
        .mockResolvedValue({ id: 'abc', isPinned: true })

      await chat.togglePinned('abc')

      expect(MockChatManager.prototype.updateChat).toHaveBeenCalledWith(
        'abc',
        expect.objectContaining({ isPinned: false, pinnedAt: undefined }),
      )
    })

    it('does nothing when chat not found', async () => {
      MockChatManager.prototype.findById = jest.fn().mockResolvedValue(null)

      await chat.togglePinned('nonexistent')

      expect(MockChatManager.prototype.updateChat).not.toHaveBeenCalled()
    })
  })

  describe('updateTitle', () => {
    it('updates the title without touching updatedAt when requested', async () => {
      await (chat as any).updateTitle('abc', 'Renamed chat', {
        touchUpdatedAt: false,
      })

      expect(MockChatManager.prototype.updateChat).toHaveBeenCalledWith(
        'abc',
        { title: 'Renamed chat' },
        { touchUpdatedAt: false },
      )
    })
  })
})
