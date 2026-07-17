import {
  type ChatConversationMetadata,
  type ChatConversationOrigin,
  getChatConversationOrigin,
} from '../../database/json/chat/types'

export type ChatHistorySection = 'user' | 'task'
export type TaskConversationOrigin = Exclude<ChatConversationOrigin, 'user'>
export type TaskOriginFilter = 'all' | TaskConversationOrigin

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
