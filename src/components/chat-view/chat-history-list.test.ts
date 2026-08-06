import type {
  ChatConversationMetadata,
  ChatConversationOrigin,
} from '../../database/json/chat/types'

import {
  captureChatListOrder,
  partitionChatHistory,
  sortChatListForDisplay,
} from './chat-history-list'

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

describe('chat list display order', () => {
  const withUpdatedAt = (
    id: string,
    updatedAt: number,
    extra: Partial<ChatConversationMetadata> = {},
  ): ChatConversationMetadata => ({
    id,
    title: id,
    updatedAt,
    schemaVersion: 1,
    origin: 'user',
    ...extra,
  })

  it('keeps the sampled order while conversations keep updating', () => {
    const initial = [withUpdatedAt('a', 20), withUpdatedAt('b', 10)]
    const snapshot = captureChatListOrder(initial, null)

    // b 后续被 agent 刷新到最新，但快照期间不应抢走 a 的位置
    const running = [withUpdatedAt('a', 20), withUpdatedAt('b', 99)]
    expect(
      sortChatListForDisplay({
        chatList: running,
        section: 'user',
        orderSnapshot: snapshot,
      }).map((chat) => chat.id),
    ).toEqual(['a', 'b'])

    expect(
      sortChatListForDisplay({
        chatList: running,
        section: 'user',
        orderSnapshot: null,
      }).map((chat) => chat.id),
    ).toEqual(['b', 'a'])
  })

  it('samples newly seen conversations once and leaves the rest untouched', () => {
    const snapshot = captureChatListOrder([withUpdatedAt('a', 20)], null)
    const extended = captureChatListOrder(
      [withUpdatedAt('c', 30), withUpdatedAt('a', 99)],
      snapshot,
    )

    expect(extended.get('a')).toBe(20)
    expect(extended.get('c')).toBe(30)
    expect(captureChatListOrder([withUpdatedAt('a', 99)], extended)).toBe(
      extended,
    )
  })

  it('still reorders immediately when the user pins a conversation', () => {
    const chats = [withUpdatedAt('a', 20), withUpdatedAt('b', 10)]
    const snapshot = captureChatListOrder(chats, null)
    const pinned = [
      withUpdatedAt('a', 20),
      withUpdatedAt('b', 10, { isPinned: true, pinnedAt: 50 }),
    ]

    expect(
      sortChatListForDisplay({
        chatList: pinned,
        section: 'user',
        orderSnapshot: snapshot,
      }).map((chat) => chat.id),
    ).toEqual(['b', 'a'])
  })
})
