import type {
  ChatConversationMetadata,
  ChatConversationOrigin,
} from '../../database/json/chat/types'

import { partitionChatHistory } from './chat-history-list'

const makeChat = (
  id: string,
  origin: ChatConversationOrigin,
  isPinned = false,
): ChatConversationMetadata => ({
  id,
  title: id,
  updatedAt: Number(id.replace(/\D/g, '')),
  schemaVersion: 1,
  origin,
  isPinned,
})

describe('partitionChatHistory', () => {
  it('applies the task origin filter after the shared archive boundary', () => {
    const futureOrigin = 'scheduled-task' as ChatConversationOrigin
    const chats = [
      makeChat('scheduled-6', futureOrigin),
      makeChat('external-5', 'external-agent'),
      makeChat('scheduled-4', futureOrigin),
      makeChat('external-3', 'external-agent'),
      makeChat('scheduled-2', futureOrigin),
      makeChat('external-1', 'external-agent'),
    ]

    const result = partitionChatHistory({
      chatList: chats,
      currentConversationId: '',
      section: 'task',
      originFilter: 'external-agent',
      useArchive: true,
      recentLimit: 3,
    })

    expect(result.activeChatList.map((chat) => chat.id)).toEqual(['external-5'])
    expect(result.archivedChatList.map((chat) => chat.id)).toEqual([
      'external-3',
      'external-1',
    ])
  })

  it('keeps pins exclusive to user history and surfaces the current archive item', () => {
    const taskChats = [
      makeChat('external-3', 'external-agent'),
      makeChat('external-2', 'external-agent'),
      makeChat('external-1', 'external-agent', true),
    ]

    const withoutCurrent = partitionChatHistory({
      chatList: taskChats,
      currentConversationId: '',
      section: 'task',
      originFilter: 'all',
      useArchive: true,
      recentLimit: 2,
    })

    expect(withoutCurrent.activeChatList.map((chat) => chat.id)).toEqual([
      'external-3',
      'external-2',
    ])
    expect(withoutCurrent.archivedChatList.map((chat) => chat.id)).toEqual([
      'external-1',
    ])

    const withCurrent = partitionChatHistory({
      chatList: taskChats,
      currentConversationId: 'external-1',
      section: 'task',
      originFilter: 'all',
      useArchive: true,
      recentLimit: 2,
    })

    expect(withCurrent.activeChatList.map((chat) => chat.id)).toContain(
      'external-1',
    )
    expect(withCurrent.archivedChatList).toEqual([])
  })
})
