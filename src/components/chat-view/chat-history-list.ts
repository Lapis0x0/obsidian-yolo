import {
  type ChatConversationMetadata,
  type ChatConversationOrigin,
  getChatConversationOrigin,
} from '../../database/json/chat/types'

export type ChatHistorySection = 'user' | 'task'
export type TaskConversationOrigin = Exclude<ChatConversationOrigin, 'user'>
export type TaskOriginFilter = 'all' | TaskConversationOrigin

/**
 * 会话的 `updatedAt` 会随 agent 运行持续刷新，直接用它实时排序会让并行运行的
 * 多个会话在面板打开期间反复换位。快照把每个会话的排序时间固定在它进入当前
 * 这次浏览时的取值，排序因此只在面板重新打开时更新。
 */
export type ChatListOrderSnapshot = ReadonlyMap<string, number>

/**
 * 把尚未记录的会话按当前 `updatedAt` 补进快照；没有新会话时返回原快照，
 * 以便调用方据引用相等跳过重排。
 */
export function captureChatListOrder(
  chatList: ChatConversationMetadata[],
  previous: ChatListOrderSnapshot | null,
): ChatListOrderSnapshot {
  let next: Map<string, number> | null = null
  chatList.forEach((chat) => {
    if (previous?.has(chat.id)) return
    next ??= new Map(previous ?? [])
    next.set(chat.id, chat.updatedAt)
  })
  return next ?? previous ?? new Map()
}

export function sortChatListForDisplay({
  chatList,
  section,
  orderSnapshot,
}: {
  chatList: ChatConversationMetadata[]
  section: ChatHistorySection
  orderSnapshot: ChatListOrderSnapshot | null
}): ChatConversationMetadata[] {
  if (chatList.length === 0) return chatList
  const canPin = section === 'user'
  const recencyOf = (chat: ChatConversationMetadata) =>
    orderSnapshot?.get(chat.id) ?? chat.updatedAt
  return [...chatList].sort((a, b) => {
    // 置顶由用户主动触发，允许立即重排，因此不进入快照。
    const aPinned = canPin && a.isPinned ? 1 : 0
    const bPinned = canPin && b.isPinned ? 1 : 0
    if (aPinned !== bPinned) {
      return bPinned - aPinned
    }
    if (aPinned && bPinned) {
      const aPinnedAt = a.pinnedAt ?? 0
      const bPinnedAt = b.pinnedAt ?? 0
      if (aPinnedAt !== bPinnedAt) {
        return bPinnedAt - aPinnedAt
      }
    }
    return recencyOf(b) - recencyOf(a)
  })
}

export function partitionChatHistory({
  chatList,
  currentConversationId,
  section,
  originFilter,
  useArchive,
  recentLimit = 50,
}: {
  chatList: ChatConversationMetadata[]
  currentConversationId: string
  section: ChatHistorySection
  originFilter: TaskOriginFilter
  useArchive: boolean
  recentLimit?: number
}): {
  activeChatList: ChatConversationMetadata[]
  archivedChatList: ChatConversationMetadata[]
} {
  const matchesOrigin = (chat: ChatConversationMetadata): boolean =>
    section === 'user' ||
    originFilter === 'all' ||
    getChatConversationOrigin(chat) === originFilter

  if (!useArchive) {
    return {
      activeChatList: chatList.filter(matchesOrigin),
      archivedChatList: [],
    }
  }

  const pinnedChats: ChatConversationMetadata[] = []
  const nonPinnedChats: ChatConversationMetadata[] = []
  chatList.forEach((chat) => {
    if (section === 'user' && chat.isPinned) {
      pinnedChats.push(chat)
    } else {
      nonPinnedChats.push(chat)
    }
  })

  const activeNonPinnedChats = nonPinnedChats.slice(0, recentLimit)
  const archivedNonPinnedChats = nonPinnedChats.slice(recentLimit)
  const currentArchivedIndex = archivedNonPinnedChats.findIndex(
    (chat) => chat.id === currentConversationId,
  )
  if (currentArchivedIndex !== -1) {
    const [currentConversation] = archivedNonPinnedChats.splice(
      currentArchivedIndex,
      1,
    )
    if (currentConversation) {
      activeNonPinnedChats.push(currentConversation)
    }
  }

  return {
    activeChatList: [...pinnedChats, ...activeNonPinnedChats].filter(
      matchesOrigin,
    ),
    archivedChatList: archivedNonPinnedChats.filter(matchesOrigin),
  }
}
