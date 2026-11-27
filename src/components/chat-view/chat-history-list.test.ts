import type {
  ChatConversationMetadata,
  ChatConversationOrigin,
} from '../../database/json/chat/types'

import {
  captureChatListOrder,
  getSortKeyAfterMove,
  groupChatHistoryByTime,
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

  it('keeps the sampled order of task conversations while they keep updating', () => {
    const initial = [withUpdatedAt('a', 20), withUpdatedAt('b', 10)]
    const snapshot = captureChatListOrder(initial, null)

    // b 后续被 agent 刷新到最新，但快照期间不应抢走 a 的位置
    const running = [withUpdatedAt('a', 20), withUpdatedAt('b', 99)]
    expect(
      sortChatListForDisplay({
        chatList: running,
        section: 'task',
        orderSnapshot: snapshot,
      }).map((chat) => chat.id),
    ).toEqual(['a', 'b'])

    expect(
      sortChatListForDisplay({
        chatList: running,
        section: 'task',
        orderSnapshot: null,
      }).map((chat) => chat.id),
    ).toEqual(['b', 'a'])
  })

  it('orders user conversations by sort key, not by activity', () => {
    const chats = [
      withUpdatedAt('a', 99, { sortKey: 1 }),
      withUpdatedAt('b', 10, { sortKey: 2 }),
    ]
    expect(
      sortChatListForDisplay({
        chatList: chats,
        section: 'user',
        orderSnapshot: null,
      }).map((chat) => chat.id),
    ).toEqual(['b', 'a'])
  })

  it('places a conversation without a sort key where it sat before', () => {
    // 没有 sortKey 的旧对话：置顶的按置顶时间，其余按最后活动时间
    const chats = [
      withUpdatedAt('old', 15),
      withUpdatedAt('new', 10, { sortKey: 20 }),
      withUpdatedAt('pin-old', 5, { isPinned: true, pinnedAt: 30 }),
      withUpdatedAt('pin-new', 5, { isPinned: true, sortKey: 40 }),
    ]
    expect(
      sortChatListForDisplay({
        chatList: chats,
        section: 'user',
        orderSnapshot: null,
      }).map((chat) => chat.id),
    ).toEqual(['pin-new', 'pin-old', 'new', 'old'])
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

  it('puts pinned conversations first', () => {
    const chats = [
      withUpdatedAt('a', 20, { sortKey: 20 }),
      withUpdatedAt('b', 10, { isPinned: true, sortKey: 10 }),
    ]
    expect(
      sortChatListForDisplay({
        chatList: chats,
        section: 'user',
        orderSnapshot: null,
      }).map((chat) => chat.id),
    ).toEqual(['b', 'a'])
  })
})

describe('getSortKeyAfterMove', () => {
  const keyed = (id: string, sortKey: number): ChatConversationMetadata => ({
    id,
    title: id,
    updatedAt: 0,
    schemaVersion: 1,
    sortKey,
  })
  // 显示顺序：sortKey 从大到小
  const list = [keyed('a', 40), keyed('b', 30), keyed('c', 20), keyed('d', 10)]
  const reorder = (fromIndex: number, toIndex: number) => {
    const sortKey = getSortKeyAfterMove(list, fromIndex, toIndex)
    const moved = list.map((chat, index) =>
      index === fromIndex ? { ...chat, sortKey } : chat,
    )
    return sortChatListForDisplay({
      chatList: moved,
      section: 'user',
      orderSnapshot: null,
    }).map((chat) => chat.id)
  }

  it('lands where it was dropped, like arrayMove', () => {
    expect(reorder(3, 1)).toEqual(['a', 'd', 'b', 'c'])
    expect(reorder(0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves to either end', () => {
    expect(reorder(2, 0)).toEqual(['c', 'a', 'b', 'd'])
    expect(reorder(1, 3)).toEqual(['a', 'c', 'd', 'b'])
  })
})

describe('groupChatHistoryByTime', () => {
  // 本地时间 2026-11-22 15:00
  const now = new Date(2026, 10, 22, 15, 0, 0).getTime()
  const at = (y: number, m: number, d: number, h = 12) =>
    new Date(y, m - 1, d, h).getTime()
  const item = (
    id: string,
    updatedAt: number,
    isPinned = false,
  ): ChatConversationMetadata => ({
    id,
    title: id,
    updatedAt,
    schemaVersion: 1,
    isPinned,
  })

  it('splits user conversations only into pinned and the rest', () => {
    const starts = groupChatHistoryByTime({
      chatList: [
        item('pinned', at(2026, 1, 1), true),
        item('today', at(2026, 11, 22, 9)),
        item('older', at(2026, 9, 1)),
      ],
      section: 'user',
      orderSnapshot: null,
      now,
    })
    expect([...starts.entries()]).toEqual([
      ['pinned', 'pinned'],
      ['today', 'conversations'],
    ])
  })

  it('titles user conversations even when none is pinned', () => {
    // 不标题的话，对话列表直接接在侧边栏的项目下面，看着像项目的一部分
    const starts = groupChatHistoryByTime({
      chatList: [item('today', at(2026, 11, 22, 9))],
      section: 'user',
      orderSnapshot: null,
      now,
    })
    expect([...starts.entries()]).toEqual([['today', 'conversations']])
  })

  it('marks only the first task conversation of each calendar group', () => {
    const starts = groupChatHistoryByTime({
      chatList: [
        item('today-1', at(2026, 11, 22, 9)),
        item('today-2', at(2026, 11, 22, 0)),
        item('yesterday', at(2026, 11, 21, 23)),
        item('week', at(2026, 11, 16)),
        item('month', at(2026, 11, 1)),
        item('older', at(2026, 9, 1)),
      ],
      section: 'task',
      orderSnapshot: null,
      now,
    })
    expect([...starts.entries()]).toEqual([
      ['today-1', 'today'],
      ['yesterday', 'yesterday'],
      ['week', 'week'],
      ['month', 'month'],
      ['older', 'older'],
    ])
  })

  it('does not group pinned conversations in the task section', () => {
    const starts = groupChatHistoryByTime({
      chatList: [item('task', at(2026, 11, 22), true)],
      section: 'task',
      orderSnapshot: null,
      now,
    })
    expect(starts.get('task')).toBe('today')
  })

  it('groups by the frozen order time while the list is being browsed', () => {
    const starts = groupChatHistoryByTime({
      chatList: [item('ran-just-now', at(2026, 11, 22))],
      section: 'task',
      orderSnapshot: new Map([['ran-just-now', at(2026, 11, 20)]]),
      now,
    })
    expect(starts.get('ran-just-now')).toBe('week')
  })
})
