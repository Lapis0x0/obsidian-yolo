import { Download, History, Plus } from 'lucide-react'
import type {
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from 'react'
import { useEffect, useRef } from 'react'

import { useLanguage } from '../../contexts/language-context'
import type { AgentConversationRunSummary } from '../../core/agent/service'
import type {
  ChatRuntimeId,
  CliRuntimeId,
  CliRuntimeScope,
} from '../../core/cli-runtime'
import type {
  ChatConversationCliSession,
  ChatConversationMetadata,
} from '../../database/json/chat/types'
import type {
  ChatConversationCompactionState,
  ChatMessage,
} from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type { MentionableBlockData } from '../../types/mentionable'

import { AssistantSelector } from './AssistantSelector'
import { ChatListDropdown } from './ChatListDropdown'
import { RuntimeSelector } from './RuntimeSelector'
import ViewToggle from './ViewToggle'

const WORKSPACE_WIDE_HEADER_MIN_WIDTH = 1200

export type ChatHeaderProps = {
  isSidebarPlacement: boolean
  activeView: 'chat' | 'composer'
  onChangeView?: (view: 'chat' | 'composer') => void
  activeRuntimeId: ChatRuntimeId
  handleRuntimeChange: (runtimeId: ChatRuntimeId) => void
  lastCliRuntimeIdRef: MutableRefObject<CliRuntimeId>
  cliRuntimeAvailable: boolean
  cliRuntimeScope: CliRuntimeScope | undefined

  // workspace-wide header 测量：containerRef 由 Chat.tsx 持有（同一节点也
  // 服务于其他用途），这里只读取 .current 做宽度测量；isWorkspaceWideHeader
  // 的状态同样归属 Chat.tsx（containerClassName/containerStyle 也要用），
  // 经 setter 直传的方式在此组件内更新。
  containerRef: RefObject<HTMLDivElement | null>
  isWorkspaceWideHeader: boolean
  setIsWorkspaceWideHeader: Dispatch<SetStateAction<boolean>>
  setWorkspaceWideHeaderHeight: Dispatch<SetStateAction<number>>

  conversationAssistantId: string
  handleConversationAssistantSelect: (assistantId: string) => void
  handleNewChat: (selectedBlock?: MentionableBlockData) => void
  handleExportChatToVault: (conversationId: string) => void
  currentConversationId: string
  chatList: ChatConversationMetadata[]
  activeHistoryConversationId: string
  runSummariesByConversationId: Map<string, AgentConversationRunSummary>
  handleLoadConversation: (conversationId: string) => Promise<void>
  getConversationById: (id: string) => Promise<{
    messages: ChatMessage[]
    overrides: ConversationOverrideSettings | null | undefined
    assistantId?: string
    conversationModelId?: string
    messageModelMap?: Record<string, string>
    activeBranchByUserMessageId?: Record<string, string>
    assistantGroupBoundaryMessageIds?: string[]
    reasoningLevel?: string
    compaction?: ChatConversationCompactionState
    cliSession?: ChatConversationCliSession
  } | null>
  deleteConversation: (id: string) => Promise<void>
  updateConversationTitle: (id: string, title: string) => Promise<void>
  syncCliConversationTitle: (conversationId: string, title: string) => void
  toggleConversationPinned: (id: string) => Promise<void>
  generateConversationTitle: (
    id: string,
    messages: ChatMessage[],
    options?: {
      force?: boolean
    },
  ) => Promise<string | null>
}

export function ChatHeader({
  isSidebarPlacement,
  activeView,
  onChangeView,
  activeRuntimeId,
  handleRuntimeChange,
  lastCliRuntimeIdRef,
  cliRuntimeAvailable,
  cliRuntimeScope,
  containerRef,
  isWorkspaceWideHeader,
  setIsWorkspaceWideHeader,
  setWorkspaceWideHeaderHeight,
  conversationAssistantId,
  handleConversationAssistantSelect,
  handleNewChat,
  handleExportChatToVault,
  currentConversationId,
  chatList,
  activeHistoryConversationId,
  runSummariesByConversationId,
  handleLoadConversation,
  getConversationById,
  deleteConversation,
  updateConversationTitle,
  syncCliConversationTitle,
  toggleConversationPinned,
  generateConversationTitle,
}: ChatHeaderProps) {
  const { t } = useLanguage()
  const headerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (isSidebarPlacement) {
      setIsWorkspaceWideHeader(false)
      return
    }

    const element = containerRef.current
    if (!element) return

    const updateIsWideHeader = (width: number) => {
      setIsWorkspaceWideHeader(width >= WORKSPACE_WIDE_HEADER_MIN_WIDTH)
    }

    updateIsWideHeader(element.getBoundingClientRect().width)

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      updateIsWideHeader(entry.contentRect.width)
    })

    resizeObserver.observe(element)

    return () => {
      resizeObserver.disconnect()
    }
  }, [isSidebarPlacement])

  useEffect(() => {
    if (isSidebarPlacement || !isWorkspaceWideHeader) {
      setWorkspaceWideHeaderHeight(0)
      return
    }

    const element = headerRef.current
    if (!element) return

    const updateHeaderHeight = (height: number) => {
      setWorkspaceWideHeaderHeight(Math.ceil(height))
    }

    updateHeaderHeight(element.getBoundingClientRect().height)

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      updateHeaderHeight(entry.contentRect.height)
    })

    resizeObserver.observe(element)

    return () => {
      resizeObserver.disconnect()
    }
  }, [isSidebarPlacement, isWorkspaceWideHeader])

  return (
    <div
      ref={headerRef}
      className={`yolo-chat-header${
        isSidebarPlacement ? '' : ' yolo-chat-header--workspace'
      }`}
    >
      <div className="yolo-chat-header-left">
        {onChangeView ? (
          <ViewToggle
            activeView={activeView}
            onChangeView={onChangeView}
            activeChatSurface={activeRuntimeId === 'yolo' ? 'chat' : 'cli'}
            onChangeChatSurface={(surface) => {
              handleRuntimeChange(
                surface === 'chat' ? 'yolo' : lastCliRuntimeIdRef.current,
              )
            }}
            showCliMode={cliRuntimeAvailable && cliRuntimeScope !== undefined}
            showComposer={isSidebarPlacement}
          />
        ) : (
          <h1 className="yolo-chat-header-title">
            {t('sidebar.tabs.chat', 'Chat')}
          </h1>
        )}
        {activeView === 'chat' && activeRuntimeId !== 'yolo' ? (
          <RuntimeSelector
            currentRuntimeId={activeRuntimeId}
            onRuntimeChange={handleRuntimeChange}
          />
        ) : null}
      </div>
      {activeView === 'chat' && (
        <div className="yolo-chat-header-right">
          {activeRuntimeId === 'yolo' ? (
            <AssistantSelector
              currentAssistantId={conversationAssistantId}
              triggerClassName={
                !isSidebarPlacement && isWorkspaceWideHeader
                  ? 'yolo-assistant-selector-button--workspace-floating'
                  : undefined
              }
              contentClassName={
                !isSidebarPlacement && isWorkspaceWideHeader
                  ? 'yolo-assistant-selector-content--workspace-floating'
                  : undefined
              }
              onAssistantChange={(assistant) => {
                handleConversationAssistantSelect(assistant.id)
              }}
            />
          ) : null}
          <div className="yolo-chat-header-buttons">
            <button
              type="button"
              onClick={() => handleNewChat()}
              className="clickable-icon"
              aria-label="New Chat"
            >
              <Plus size={18} />
            </button>
            {activeRuntimeId === 'yolo' ? (
              <button
                type="button"
                onClick={() => handleExportChatToVault(currentConversationId)}
                className="clickable-icon"
                aria-label={t(
                  'sidebar.chatList.exportConversation',
                  'Export conversation to vault',
                )}
              >
                <Download size={18} />
              </button>
            ) : null}
            <ChatListDropdown
              chatList={chatList}
              currentConversationId={activeHistoryConversationId}
              runSummariesByConversationId={runSummariesByConversationId}
              onSelect={(conversationId) => {
                if (conversationId === activeHistoryConversationId) return
                void handleLoadConversation(conversationId)
              }}
              onDelete={(conversationId) => {
                void (async () => {
                  const conversation = await getConversationById(conversationId)
                  await deleteConversation(conversationId)
                  if (conversation?.cliSession && cliRuntimeScope) {
                    await cliRuntimeScope.sessionService.removeOverlay(
                      conversation.cliSession,
                    )
                  }
                  if (conversationId === activeHistoryConversationId) {
                    if (activeRuntimeId !== 'yolo') {
                      handleNewChat()
                      return
                    }
                    const nextConversation = chatList.find(
                      (chat) => chat.id !== conversationId,
                    )
                    if (nextConversation) {
                      void handleLoadConversation(nextConversation.id)
                    } else {
                      handleNewChat()
                    }
                  }
                })()
              }}
              onUpdateTitle={async (conversationId, newTitle) => {
                await updateConversationTitle(conversationId, newTitle)
                syncCliConversationTitle(conversationId, newTitle)
              }}
              onTogglePinned={(conversationId) => {
                void toggleConversationPinned(conversationId)
              }}
              onRetryTitle={async (conversationId) => {
                const conversation = await getConversationById(conversationId)
                if (!conversation) {
                  console.error(
                    'Failed to retry conversation title generation: conversation not found',
                    {
                      conversationId,
                    },
                  )
                  return
                }
                const title = await generateConversationTitle(
                  conversationId,
                  conversation.messages,
                  {
                    force: true,
                  },
                )
                if (title) syncCliConversationTitle(conversationId, title)
              }}
              onExportConversation={handleExportChatToVault}
            >
              <History size={18} />
            </ChatListDropdown>
          </div>
        </div>
      )}
    </div>
  )
}
