import {
  type ChatConversationMetadata,
  type ChatConversationOrigin,
  getChatConversationOrigin,
  getLegacyChatSortKey,
} from '../../database/json/chat/types'

export type ChatHistorySection = 'user' | 'task'
export type TaskConversationOrigin = Exclude<ChatConversationOrigin, 'user'>
export type TaskOriginFilter = 'all' | TaskConversationOrigin

/**
 * 任务对话按活动时间排。会话的 `updatedAt` 会随 agent 运行持续刷新，直接用它
 * 实时排序会让并行运行的多个会话在面板打开期间反复换位。快照把每个会话的排序
 * 时间固定在它进入当前这次浏览时的取值，排序因此只在面板重新打开时更新。
 * 用户自己的对话由用户拖动排序（`sortKey`），用不到快照。
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
  if (section === 'user') return sortUserChatList(chatList)
  const recencyOf = (chat: ChatConversationMetadata) =>
    orderSnapshot?.get(chat.id) ?? chat.updatedAt
  return [...chatList].sort((a, b) => recencyOf(b) - recencyOf(a))
}

export const getChatSortKey = (chat: ChatConversationMetadata): number =>
  chat.sortKey ?? getLegacyChatSortKey(chat)

/** 项目里的对话，按用户拖出来的顺序（项目里不分置顶） */
export const selectProjectConversations = (
  chatList: readonly ChatConversationMetadata[],
  projectId: string,
): ChatConversationMetadata[] =>
  chatList
    .filter(
      (chat) =>
        chat.projectId === projectId &&
        getChatConversationOrigin(chat) === 'user',
    )
    .sort(
      (a, b) =>
        getChatSortKey(b) - getChatSortKey(a) || a.id.localeCompare(b.id),
    )

/** 用户自己的对话：置顶的在前，两组各自按用户拖出来的顺序 */
export function sortUserChatList<T extends ChatConversationMetadata>(
  chatList: readonly T[],
): T[] {
  return [...chatList].sort((a, b) => {
    const aPinned = a.isPinned ? 1 : 0
    const bPinned = b.isPinned ? 1 : 0
    if (aPinned !== bPinned) return bPinned - aPinned
    return getChatSortKey(b) - getChatSortKey(a) || a.id.localeCompare(b.id)
  })
}

/**
 * 一个对话插进 `list` 的第 `index` 位时它的 sortKey：取上下两个邻居的中间值，
 * 只改这一项。`list` 是目标那一组的完整列表（没折叠、没截断），按显示顺序
 * 排好（sortKey 从大到小），不含要插进来的这一项。
 */
export function getSortKeyForInsert(
  list: readonly ChatConversationMetadata[],
  index: number,
): number {
  const above = list[index - 1]
  const below = list[index]
  if (above && below) {
    return (getChatSortKey(above) + getChatSortKey(below)) / 2
  }
  if (above) return getChatSortKey(above) - 1
  if (below) return getChatSortKey(below) + 1
  return Date.now()
}

/**
 * 同一组里把第 `fromIndex` 项拖到第 `toIndex` 位（arrayMove 的语义）时它的
 * 新 sortKey。
 */
export function getSortKeyAfterMove(
  list: readonly ChatConversationMetadata[],
  fromIndex: number,
  toIndex: number,
): number {
  return getSortKeyForInsert(
    list.filter((_, index) => index !== fromIndex),
    toIndex,
  )
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

export type ChatHistoryTimeGroup =
  | 'pinned'
  /** 用户对话里置顶之外的其余对话 */
  | 'conversations'
  | 'today'
  | 'yesterday'
  | 'week'
  | 'month'
  | 'older'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 给按显示顺序排好的列表标出每个分组的第一条。用户对话由用户排序，只分置顶
 * 和其余两组；任务对话按时间分组。
 *
 * 以下说的是任务对话：标出每个时间分组的第一条。只记分组起点，分组标题因此
 * 能插在同一个扁平列表里，不打断删除 / 置顶补位用的连续索引。
 *
 * 时间按本地日历日算：「今天」从本地零点起，「前 7 天」「前 30 天」从今天零点往前
 * 数。排序时间与列表排序同源（交互期间取快照），两者不会互相矛盾。置顶只在
 * 「我的对话」里成组。
 */
export function groupChatHistoryByTime({
  chatList,
  section,
  orderSnapshot,
  now,
}: {
  chatList: ChatConversationMetadata[]
  section: ChatHistorySection
  orderSnapshot: ChatListOrderSnapshot | null
  now: number
}): Map<string, ChatHistoryTimeGroup> {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const today = startOfToday.getTime()
  const groupOf = (chat: ChatConversationMetadata): ChatHistoryTimeGroup => {
    if (section === 'user') return chat.isPinned ? 'pinned' : 'conversations'
    const time = orderSnapshot?.get(chat.id) ?? chat.updatedAt
    if (time >= today) return 'today'
    if (time >= today - DAY_MS) return 'yesterday'
    if (time >= today - 7 * DAY_MS) return 'week'
    if (time >= today - 30 * DAY_MS) return 'month'
    return 'older'
  }
  const starts = new Map<string, ChatHistoryTimeGroup>()
  let previous: ChatHistoryTimeGroup | null = null
  chatList.forEach((chat) => {
    const group = groupOf(chat)
    if (group !== previous) starts.set(chat.id, group)
    previous = group
  })
  return starts
}
